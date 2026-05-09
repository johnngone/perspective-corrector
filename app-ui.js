/**
 * app-ui.js — Canvas rendering, loupe, guide drawing, hit testing.
 */

const GUIDE_ORDER = ['v1','v2','h1','h2'];
const GUIDE_COLORS = { v1:'#22ff88', v2:'#00c5ff', h1:'#ffcc33', h2:'#ff7f50' };
const HANDLE_R = 7;
const HIT_ENDPOINT = 12;
const HIT_LINE = 8;

class AppUI {
  constructor(canvasEl, loupeEl, loupeCanvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.loupeEl = loupeEl;
    this.loupeCanvas = loupeCanvasEl;
    this.loupeCtx = loupeCanvasEl.getContext('2d');
    this.image = null;
    this.imgW = 0;
    this.imgH = 0;
    this.sourceCanvas = null;
    this.sourceCtx = null;
    this.viewScale = 1;
    this.offX = 0;
    this.offY = 0;
    this.guides = {};
    this.hoveringGuide = null;
    this.hoverGrip = null;
    this.showGrid = false;
    this.showLabels = true;
    this._dirty = true;
    // DPR-aware sizing (set by App._setupCanvas)
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
  }

  setImage(img) {
    this.image = img;
    this.imgW = img.naturalWidth || img.width;
    this.imgH = img.naturalHeight || img.height;
    this.sourceCanvas = document.createElement('canvas');
    this.sourceCanvas.width = this.imgW;
    this.sourceCanvas.height = this.imgH;
    this.sourceCtx = this.sourceCanvas.getContext('2d');
    this.sourceCtx.drawImage(img, 0, 0);
    this.setDefaultGuides();
    this.fitView();
    this._dirty = true;
  }

  fitView() {
    // Use CSS dimensions for layout math (not canvas.width which is DPR-scaled)
    const cw = this.cssW || this.canvas.width;
    const ch = this.cssH || this.canvas.height;
    if (!this.imgW) return;
    this.viewScale = Math.min(cw / this.imgW, ch / this.imgH, 1);
    this.offX = (cw - this.imgW * this.viewScale) / 2;
    this.offY = (ch - this.imgH * this.viewScale) / 2;
    this._dirty = true;
  }

  setDefaultGuides() {
    const w = this.imgW, h = this.imgH;
    this.guides = {
      v1: [[0.30*w, 0.08*h],[0.30*w, 0.92*h]],
      v2: [[0.70*w, 0.08*h],[0.70*w, 0.92*h]],
      h1: [[0.08*w, 0.28*h],[0.92*w, 0.28*h]],
      h2: [[0.08*w, 0.72*h],[0.92*w, 0.72*h]],
    };
    this._dirty = true;
  }

  imgToCanvas(x, y) {
    return [x * this.viewScale + this.offX, y * this.viewScale + this.offY];
  }

  canvasToImg(cx, cy) {
    let x = (cx - this.offX) / this.viewScale;
    let y = (cy - this.offY) / this.viewScale;
    x = Math.max(0, Math.min(this.imgW - 1, x));
    y = Math.max(0, Math.min(this.imgH - 1, y));
    return [x, y];
  }

  hitTest(cx, cy) {
    if (!this.guides.v1) return null;
    for (const key of GUIDE_ORDER) {
      const [p1, p2] = this.guides[key];
      const [x1,y1] = this.imgToCanvas(p1[0],p1[1]);
      const [x2,y2] = this.imgToCanvas(p2[0],p2[1]);
      if (Math.hypot(cx-x1, cy-y1) <= HIT_ENDPOINT) return {mode:'endpoint',key,idx:0};
      if (Math.hypot(cx-x2, cy-y2) <= HIT_ENDPOINT) return {mode:'endpoint',key,idx:1};
    }
    let best = null, bestD = Infinity;
    for (const key of GUIDE_ORDER) {
      const [p1,p2] = this.guides[key];
      const [x1,y1] = this.imgToCanvas(p1[0],p1[1]);
      const [x2,y2] = this.imgToCanvas(p2[0],p2[1]);
      const d = ptSegDist(cx,cy,x1,y1,x2,y2);
      if (d < bestD) { bestD = d; best = key; }
    }
    if (best && bestD <= HIT_LINE) return {mode:'line',key:best,idx:null};
    return null;
  }

  nearestEndpoint(key, cx, cy) {
    const [p1,p2] = this.guides[key];
    const [x1,y1] = this.imgToCanvas(p1[0],p1[1]);
    const [x2,y2] = this.imgToCanvas(p2[0],p2[1]);
    return Math.hypot(cx-x1,cy-y1) <= Math.hypot(cx-x2,cy-y2) ? 0 : 1;
  }

  clampSegment(p1, p2) {
    const w = this.imgW - 1, h = this.imgH - 1;
    let sx = 0, sy = 0;
    const mnx = Math.min(p1[0],p2[0]), mxx = Math.max(p1[0],p2[0]);
    const mny = Math.min(p1[1],p2[1]), mxy = Math.max(p1[1],p2[1]);
    if (mnx < 0) sx = -mnx; else if (mxx > w) sx = w - mxx;
    if (mny < 0) sy = -mny; else if (mxy > h) sy = h - mxy;
    return [[p1[0]+sx,p1[1]+sy],[p2[0]+sx,p2[1]+sy]];
  }

  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    const cw = this.cssW || this.canvas.width;
    const ch = this.cssH || this.canvas.height;

    // Scale context for HiDPI; all coordinates below are in CSS pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!this.image) return;

    // Viewport-clipped draw: only render the visible portion of the image
    // to avoid exceeding browser canvas texture limits at extreme zoom levels
    const vs = this.viewScale;
    const srcL = Math.max(0, Math.floor(-this.offX / vs));
    const srcT = Math.max(0, Math.floor(-this.offY / vs));
    const srcR = Math.min(this.imgW, Math.ceil((cw - this.offX) / vs));
    const srcB = Math.min(this.imgH, Math.ceil((ch - this.offY) / vs));
    if (srcR <= srcL || srcB <= srcT) { this._dirty = false; return; }

    const dstX = this.offX + srcL * vs;
    const dstY = this.offY + srcT * vs;
    const dstW = (srcR - srcL) * vs;
    const dstH = (srcB - srcT) * vs;

    ctx.save();
    ctx.imageSmoothingEnabled = vs < 4;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, srcL, srcT, srcR - srcL, srcB - srcT, dstX, dstY, dstW, dstH);
    ctx.restore();

    if (this.showGrid) this._drawGrid(ctx, cw, ch);
    if (!this.guides.v1) return;

    for (const key of GUIDE_ORDER) {
      const [p1,p2] = this.guides[key];
      const [x1,y1] = this.imgToCanvas(p1[0],p1[1]);
      const [x2,y2] = this.imgToCanvas(p2[0],p2[1]);
      const col = GUIDE_COLORS[key];
      const w = this.hoveringGuide === key ? 3 : 2;

      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();

      for (let i = 0; i < 2; i++) {
        const px = i===0?x1:x2, py = i===0?y1:y2;
        const active = this.hoverGrip && this.hoverGrip[0]===key && this.hoverGrip[1]===i;
        ctx.beginPath(); ctx.arc(px,py,HANDLE_R,0,Math.PI*2);
        ctx.fillStyle = active ? col : '#fff';
        ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      }

      if (this.showLabels) {
        const mx = (x1+x2)/2+8, my = (y1+y2)/2-8;
        const lbl = key.toUpperCase() + (key[0]==='v'?' Vert':' Horiz');
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.fillStyle = col; ctx.fillText(lbl, mx, my);
      }
    }
    this._dirty = false;
  }

  _drawGrid(ctx, cw, ch) {
    if (!this.image) return;
    const [ox,oy] = this.imgToCanvas(0,0);
    const iw = this.imgW*this.viewScale, ih = this.imgH*this.viewScale;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const x = ox + iw * i/3; ctx.beginPath(); ctx.moveTo(x,oy); ctx.lineTo(x,oy+ih); ctx.stroke();
      const y = oy + ih * i/3; ctx.beginPath(); ctx.moveTo(ox,y); ctx.lineTo(ox+iw,y); ctx.stroke();
    }
  }

  updateLoupe(guideKey, epIdx, refX, refY) {
    if (!this.image || !this.sourceCtx) { this.hideLoupe(); return; }
    const [ix, iy] = this.guides[guideKey][epIdx];
    const R = 12, Z = 12, side = R*2+1, sz = side*Z;
    this.loupeCanvas.width = sz; this.loupeCanvas.height = sz;
    const lctx = this.loupeCtx;
    const cx = Math.round(ix), cy = Math.round(iy);

    lctx.fillStyle = '#111'; lctx.fillRect(0,0,sz,sz);
    lctx.imageSmoothingEnabled = false;
    lctx.drawImage(this.sourceCanvas, cx-R, cy-R, side, side, 0, 0, sz, sz);

    lctx.strokeStyle = 'rgba(75,75,75,0.6)'; lctx.lineWidth = 1;
    for (let i = 0; i <= side; i++) {
      const p = i*Z; lctx.beginPath(); lctx.moveTo(p,0); lctx.lineTo(p,sz); lctx.stroke();
      lctx.beginPath(); lctx.moveTo(0,p); lctx.lineTo(sz,p); lctx.stroke();
    }
    const ctr = R*Z + Z/2;
    lctx.strokeStyle = 'rgba(255,64,64,0.8)'; lctx.lineWidth = 2;
    lctx.beginPath(); lctx.moveTo(ctr,0); lctx.lineTo(ctr,sz); lctx.stroke();
    lctx.beginPath(); lctx.moveTo(0,ctr); lctx.lineTo(sz,ctr); lctx.stroke();

    this.loupeEl.style.left = (refX + 24) + 'px';
    this.loupeEl.style.top = (refY + 24) + 'px';
    this.loupeEl.classList.add('visible');
  }

  hideLoupe() { this.loupeEl.classList.remove('visible'); }

  markDirty() { this._dirty = true; }
  get dirty() { return this._dirty; }
  getAngles() { return measureGuideAngles(this.guides); }
}

function ptSegDist(px,py,x1,y1,x2,y2) {
  const dx=x2-x1, dy=y2-y1;
  if (dx===0&&dy===0) return Math.hypot(px-x1,py-y1);
  const t = Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
}

// GUIDE_ORDER and GUIDE_COLORS are global
