/**
 * app.js — Main entry: events, drag-drop, undo/redo, export orchestration.
 */

class App {
  constructor() {
    this.ui = new AppUI(
      document.getElementById('main-canvas'),
      document.getElementById('loupe'),
      document.getElementById('loupe-canvas')
    );
    this.container = document.getElementById('canvas-container');
    this.dragState = null;
    this.panState = null;
    this.spaceDown = false;
    this.undoStack = [];
    this.redoStack = [];
    this.worker = null;
    this._setupCanvas();
    this._bindToolbar();
    this._bindPointer();
    this._bindKeyboard();
    this._bindDrop();
    this._bindSidebar();
    this._raf();
  }

  // ── Canvas sizing (DPR-aware for mobile HiDPI) ──
  _setupCanvas() {
    const ro = new ResizeObserver(() => {
      const r = this.container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.ui.canvas.width = Math.round(r.width * dpr);
      this.ui.canvas.height = Math.round(r.height * dpr);
      this.ui.cssW = r.width;
      this.ui.cssH = r.height;
      this.ui.dpr = dpr;
      if (this.ui.image) this.ui.fitView();
      this.ui.markDirty();
    });
    ro.observe(this.container);
  }

  // ── Render loop ──
  _raf() {
    if (this.ui.dirty) this.ui.draw();
    requestAnimationFrame(() => this._raf());
  }

  // ── Toolbar ──
  _bindToolbar() {
    document.getElementById('btn-open').onclick = () => this._openFilePicker();
    document.getElementById('btn-reset').onclick = () => this._resetGuides();
    document.getElementById('btn-undo').onclick = () => this._undo();
    document.getElementById('btn-redo').onclick = () => this._redo();
    document.getElementById('btn-export').onclick = () => this._export();
    document.getElementById('btn-import-guides').onclick = () => this._importGuides();
    document.getElementById('btn-export-guides').onclick = () => this._exportGuides();
    // Click the empty canvas to open an image
    document.getElementById('empty-state').onclick = () => this._openFilePicker();
  }

  _openFilePicker() {
    const inp = document.getElementById('file-input');
    inp.onchange = () => { if (inp.files.length) this._handleFiles(inp.files); inp.value = ''; };
    inp.click();
  }

  // ── File handling ──
  _handleFiles(files) {
    for (const f of files) {
      if (f.type.startsWith('image/')) { this._loadImage(f); return; }
      if (f.name.endsWith('.json')) { this._loadGuideFile(f); return; }
    }
  }

  _loadImage(file) {
    // Store base filename without extension for exports
    this._sourceBaseName = file.name.replace(/\.[^.]+$/, '');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      this.ui.setImage(img);
      this.undoStack = []; this.redoStack = [];
      this._pushUndo();
      document.getElementById('empty-state').style.display = 'none';
      this._setStatus(`Loaded ${file.name} (${img.naturalWidth}×${img.naturalHeight})`);
      this._updateDims();
      this._updateAngles();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { this._setStatus('Failed to load image.'); URL.revokeObjectURL(url); };
    img.src = url;
  }

  _loadGuideFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.v1 && data.v2 && data.h1 && data.h2) {
          this._pushUndo();
          this.ui.guides = data;
          this.ui.markDirty();
          this._updateAngles();
          this._setStatus('Guides imported from ' + file.name);
        } else { this._setStatus('Invalid guide file.'); }
      } catch { this._setStatus('Could not parse guide file.'); }
    };
    reader.readAsText(file);
  }

  // ── Drag & Drop ──
  _bindDrop() {
    const overlay = document.getElementById('drop-overlay');
    let dragCounter = 0;
    document.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; overlay.classList.add('visible'); });
    document.addEventListener('dragleave', e => { e.preventDefault(); dragCounter--; if (dragCounter<=0){dragCounter=0;overlay.classList.remove('visible');} });
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      e.preventDefault(); dragCounter=0; overlay.classList.remove('visible');
      if (e.dataTransfer.files.length) this._handleFiles(e.dataTransfer.files);
    });
    // Clipboard paste
    document.addEventListener('paste', e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) { this._loadImage(item.getAsFile()); return; }
      }
    });
  }

  // ── Pointer events (guide drag, pan, zoom) ──
  _bindPointer() {
    const c = this.container;
    c.addEventListener('pointerdown', e => this._onPointerDown(e));
    c.addEventListener('pointermove', e => this._onPointerMove(e));
    c.addEventListener('pointerup', e => this._onPointerUp(e));
    c.addEventListener('pointerleave', () => { this.ui.hoveringGuide=null; this.ui.hoverGrip=null; this.ui.hideLoupe(); this.ui.markDirty(); });
    c.addEventListener('wheel', e => { e.preventDefault(); this._onWheel(e); }, {passive:false});
    c.addEventListener('contextmenu', e => e.preventDefault());

    // ── Mobile touch: two-finger pan+zoom, single-finger pan if no guide ──
    let lastPinchDist = 0;
    let lastPinchCX = 0, lastPinchCY = 0;
    let touchPanning = false;
    let touchPanLX = 0, touchPanLY = 0;

    c.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        e.preventDefault();
        // Cancel any single-finger pan/drag
        touchPanning = false;
        this.dragState = null;
        const t0 = e.touches[0], t1 = e.touches[1];
        lastPinchDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        lastPinchCX = (t0.clientX + t1.clientX) / 2;
        lastPinchCY = (t0.clientY + t1.clientY) / 2;
      } else if (e.touches.length === 1 && this.ui.image && !this.dragState) {
        // Single finger: check if touching a guide; if not, pan
        const r = this.ui.canvas.getBoundingClientRect();
        const cx = e.touches[0].clientX - r.left;
        const cy = e.touches[0].clientY - r.top;
        const hit = this.ui.hitTest(cx, cy);
        if (!hit) {
          touchPanning = true;
          touchPanLX = e.touches[0].clientX;
          touchPanLY = e.touches[0].clientY;
        }
      }
    }, {passive: false});

    c.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && this.ui.image) {
        e.preventDefault();
        const t0 = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        const mcx = (t0.clientX + t1.clientX) / 2;
        const mcy = (t0.clientY + t1.clientY) / 2;

        if (lastPinchDist > 0) {
          // Pan: midpoint movement
          this.ui.offX += mcx - lastPinchCX;
          this.ui.offY += mcy - lastPinchCY;

          // Zoom: distance change, centered on midpoint
          const factor = dist / lastPinchDist;
          const r = this.ui.canvas.getBoundingClientRect();
          this._zoomAt(mcx - r.left, mcy - r.top, factor);
        }
        lastPinchDist = dist;
        lastPinchCX = mcx;
        lastPinchCY = mcy;
      } else if (e.touches.length === 1 && touchPanning) {
        e.preventDefault();
        const tx = e.touches[0].clientX, ty = e.touches[0].clientY;
        this.ui.offX += tx - touchPanLX;
        this.ui.offY += ty - touchPanLY;
        touchPanLX = tx;
        touchPanLY = ty;
        this.ui.markDirty();
      }
    }, {passive: false});

    c.addEventListener('touchend', e => {
      if (e.touches.length < 2) { lastPinchDist = 0; }
      if (e.touches.length === 0) { touchPanning = false; }
    });
  }

  _canvasXY(e) {
    const r = this.ui.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _onPointerDown(e) {
    if (!this.ui.image) return;
    const [cx,cy] = this._canvasXY(e);

    // Middle button or space+click = pan
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.panState = {lx:cx,ly:cy};
      this.container.style.cursor = 'grabbing';
      this.container.setPointerCapture(e.pointerId);
      return;
    }

    // Right button = pan
    if (e.button === 2) {
      this.panState = {lx:cx,ly:cy};
      this.container.style.cursor = 'grabbing';
      this.container.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;
    const hit = this.ui.hitTest(cx, cy);
    if (!hit) {
      // No guide hit — left-click pan
      this.dragState = null;
      this.panState = {lx:cx, ly:cy};
      this.container.style.cursor = 'grabbing';
      this.container.setPointerCapture(e.pointerId);
      return;
    }
    this._pushUndo();
    const epIdx = hit.idx ?? this.ui.nearestEndpoint(hit.key, cx, cy);
    this.dragState = {
      mode: hit.mode, key: hit.key, idx: epIdx,
      lastImg: hit.mode === 'line' ? this.ui.canvasToImg(cx,cy) : null
    };
    this.ui.hoveringGuide = hit.key;
    this.ui.hoverGrip = [hit.key, epIdx];
    this.ui.updateLoupe(hit.key, epIdx, e.clientX, e.clientY);
    this.container.setPointerCapture(e.pointerId);
  }

  _onPointerMove(e) {
    if (!this.ui.image) return;
    const [cx,cy] = this._canvasXY(e);

    // Pan
    if (this.panState) {
      this.ui.offX += cx - this.panState.lx;
      this.ui.offY += cy - this.panState.ly;
      this.panState.lx = cx; this.panState.ly = cy;
      this.ui.markDirty();
      return;
    }

    // Drag guide
    if (this.dragState) {
      let [ix,iy] = this.ui.canvasToImg(cx,cy);
      const g = this.ui.guides[this.dragState.key];

      if (e.shiftKey) {
        // Snap: for vertical guides lock X, for horizontal lock Y
        if (this.dragState.key.startsWith('v')) {
          if (this.dragState.mode === 'endpoint') {
            ix = g[1-this.dragState.idx][0]; // align X with other endpoint
          }
        } else {
          if (this.dragState.mode === 'endpoint') {
            iy = g[1-this.dragState.idx][1];
          }
        }
      }

      if (this.dragState.mode === 'endpoint') {
        g[this.dragState.idx] = [ix, iy];
      } else if (this.dragState.lastImg) {
        const [lx,ly] = this.dragState.lastImg;
        const dx = ix-lx, dy = iy-ly;
        const np1 = [g[0][0]+dx, g[0][1]+dy], np2 = [g[1][0]+dx, g[1][1]+dy];
        const [cp1,cp2] = this.ui.clampSegment(np1, np2);
        g[0] = cp1; g[1] = cp2;
        this.dragState.lastImg = [ix,iy];
      }

      this.ui.hoveringGuide = this.dragState.key;
      this.ui.hoverGrip = [this.dragState.key, this.dragState.idx];
      this.ui.markDirty();
      this.ui.updateLoupe(this.dragState.key, this.dragState.idx, e.clientX, e.clientY);
      this._updateAngles();
      return;
    }

    // Hover
    const hit = this.ui.hitTest(cx, cy);
    if (hit) {
      const epIdx = hit.idx ?? this.ui.nearestEndpoint(hit.key, cx, cy);
      this.ui.hoveringGuide = hit.key;
      this.ui.hoverGrip = [hit.key, epIdx];
      this.container.style.cursor = hit.mode === 'endpoint' ? 'grab' : 'move';
      this.ui.updateLoupe(hit.key, epIdx, e.clientX, e.clientY);
    } else {
      this.ui.hoveringGuide = null;
      this.ui.hoverGrip = null;
      this.container.style.cursor = this.spaceDown ? 'grab' : 'crosshair';
      this.ui.hideLoupe();
    }
    this.ui.markDirty();
  }

  _onPointerUp(e) {
    if (this.panState) {
      this.panState = null;
      this.container.style.cursor = 'crosshair';
    }
    if (this.dragState) {
      this.dragState = null;
      this._updateAngles();
    }
    this.container.releasePointerCapture(e.pointerId);
  }

  _onWheel(e) {
    if (!this.ui.image) return;
    const [cx,cy] = this._canvasXY(e);
    const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
    this._zoomAt(cx, cy, factor);
  }

  _zoomAt(cx, cy, factor) {
    const old = this.ui.viewScale;
    const nw = Math.max(0.03, Math.min(24, old * factor));
    if (Math.abs(nw-old) < 1e-12) return;
    const ix = (cx - this.ui.offX) / old;
    const iy = (cy - this.ui.offY) / old;
    this.ui.viewScale = nw;
    this.ui.offX = cx - ix * nw;
    this.ui.offY = cy - iy * nw;
    this.ui.markDirty();
    this._updateZoom();
  }

  // ── Keyboard ──
  _bindKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.spaceDown = true; this.container.style.cursor = 'grab'; }
      if (e.key === 'r' || e.key === 'R') this._resetGuides();
      if (e.key === '0') { if(this.ui.image) { this.ui.fitView(); this._updateZoom(); } }
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); this._undo(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); this._redo(); }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); this._export(); }
      if (e.ctrlKey && e.key === 'o') { e.preventDefault(); this._openFilePicker(); }
      if (e.key === '=' || e.key === '+') this._zoomAt(this.ui.canvas.width/2, this.ui.canvas.height/2, 1.1);
      if (e.key === '-') this._zoomAt(this.ui.canvas.width/2, this.ui.canvas.height/2, 1/1.1);

      // Arrow/WASD nudge: move hovered/dragged grip by 1px (10px with Shift)
      const nudgeKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','W','A','S','D'];
      if (nudgeKeys.includes(e.key)) {
        const grip = this.dragState
          ? { key: this.dragState.key, idx: this.dragState.idx }
          : (this.ui.hoverGrip ? { key: this.ui.hoverGrip[0], idx: this.ui.hoverGrip[1] } : null);
        if (grip && this.ui.guides[grip.key]) {
          e.preventDefault();
          if (!this._nudging) { this._pushUndo(); this._nudging = true; }
          const step = e.shiftKey ? 10 : 1;
          const pt = this.ui.guides[grip.key][grip.idx];
          const k = e.key.toLowerCase();
          if (k === 'arrowleft'  || k === 'a') pt[0] = Math.max(0, pt[0] - step);
          if (k === 'arrowright' || k === 'd') pt[0] = Math.min(this.ui.imgW - 1, pt[0] + step);
          if (k === 'arrowup'    || k === 'w') pt[1] = Math.max(0, pt[1] - step);
          if (k === 'arrowdown'  || k === 's') pt[1] = Math.min(this.ui.imgH - 1, pt[1] + step);
          this.ui.markDirty();
          this._updateAngles();
          // Update loupe at the grip's canvas position
          const [cx, cy] = this.ui.imgToCanvas(pt[0], pt[1]);
          const rect = this.ui.canvas.getBoundingClientRect();
          this.ui.updateLoupe(grip.key, grip.idx, rect.left + cx, rect.top + cy);
        }
      }
    });
    document.addEventListener('keyup', e => {
      if (e.code === 'Space') { this.spaceDown = false; this.container.style.cursor = 'crosshair'; }
      if (e.key.startsWith('Arrow') || 'wasdWASD'.includes(e.key)) { this._nudging = false; }
    });
  }

  // ── Sidebar ──
  _bindSidebar() {
    document.getElementById('toggle-grid').onchange = e => { this.ui.showGrid = e.target.checked; this.ui.markDirty(); };
    document.getElementById('toggle-labels').onchange = e => { this.ui.showLabels = e.target.checked; this.ui.markDirty(); };
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.onclick = () => {
        const h = parseFloat(btn.dataset.h), v = parseFloat(btn.dataset.v);
        document.getElementById('aspect-h').value = h || '';
        document.getElementById('aspect-v').value = v || '';
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });

    // ── Mobile sidebar toggle ──
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('btn-sidebar-toggle');
    // Create backdrop element for mobile
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    sidebar.parentElement.insertBefore(backdrop, sidebar);

    const openSidebar = () => {
      sidebar.classList.add('mobile-open');
      backdrop.classList.add('visible');
      toggleBtn.classList.add('active');
    };
    const closeSidebar = () => {
      sidebar.classList.remove('mobile-open');
      backdrop.classList.remove('visible');
      toggleBtn.classList.remove('active');
    };

    const toggle = () => {
      if (sidebar.classList.contains('mobile-open')) closeSidebar();
      else openSidebar();
    };

    toggleBtn.addEventListener('pointerup', e => { e.stopPropagation(); toggle(); });
    toggleBtn.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); });
    backdrop.addEventListener('pointerup', closeSidebar);
  }

  // ── Undo / Redo ──
  _pushUndo() {
    if (!this.ui.guides.v1) return;
    this.undoStack.push(JSON.parse(JSON.stringify(this.ui.guides)));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  _undo() {
    if (this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop());
    this.ui.guides = JSON.parse(JSON.stringify(this.undoStack[this.undoStack.length-1]));
    this.ui.markDirty();
    this._updateAngles();
    this._setStatus('Undo');
  }

  _redo() {
    if (!this.redoStack.length) return;
    const state = this.redoStack.pop();
    this.undoStack.push(state);
    this.ui.guides = JSON.parse(JSON.stringify(state));
    this.ui.markDirty();
    this._updateAngles();
    this._setStatus('Redo');
  }

  // ── Reset ──
  _resetGuides() {
    if (!this.ui.image) return;
    this._pushUndo();
    this.ui.setDefaultGuides();
    this._updateAngles();
    this._setStatus('Guides reset to defaults.');
  }

  // ── Export corrected image ──
  async _export() {
    if (!this.ui.image) { this._setStatus('No image loaded.'); return; }
    const aH = parseFloat(document.getElementById('aspect-h').value) || 0;
    const aV = parseFloat(document.getElementById('aspect-v').value) || 0;
    let result;
    try {
      result = computeOutputTransform(this.ui.guides, this.ui.imgW, this.ui.imgH, aH, aV);
    } catch (err) { this._setStatus('Error: ' + err.message); return; }

    const { transform, outW, outH } = result;
    const progressEl = document.getElementById('progress-overlay');
    const fillEl = document.getElementById('progress-fill');
    progressEl.classList.add('visible');
    fillEl.style.width = '0%';

    const srcData = this.ui.sourceCtx.getImageData(0, 0, this.ui.imgW, this.ui.imgH).data;

    try {
      const output = await this._runWarp(srcData, this.ui.imgW, this.ui.imgH, transform, outW, outH, p => {
        fillEl.style.width = Math.round(p*100) + '%';
      });

      const warpCanvas = document.createElement('canvas');
      warpCanvas.width = outW; warpCanvas.height = outH;
      const wctx = warpCanvas.getContext('2d');
      const imgData = new ImageData(output, outW, outH);
      wctx.putImageData(imgData, 0, 0);

      // Optionally crop to guide bounds
      const doCrop = document.getElementById('toggle-crop').checked;
      let exportCanvas = warpCanvas;
      let finalW = outW, finalH = outH;

      if (doCrop) {
        const crop = computeCropBounds(this.ui.guides, transform, outW, outH);
        if (crop.w > 0 && crop.h > 0) {
          exportCanvas = document.createElement('canvas');
          exportCanvas.width = crop.w;
          exportCanvas.height = crop.h;
          const cctx = exportCanvas.getContext('2d');
          cctx.drawImage(warpCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
          finalW = crop.w;
          finalH = crop.h;
        }
      }

      const fmt = document.getElementById('export-format').value;
      const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
      const quality = fmt === 'jpeg' ? 0.95 : undefined;

      exportCanvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const baseName = this._sourceBaseName || 'image';
        a.download = `${baseName}_corrected.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        progressEl.classList.remove('visible');
        this._setStatus(`Exported ${finalW}×${finalH} ${fmt.toUpperCase()}${doCrop ? ' (cropped)' : ''}`);
      }, mime, quality);
    } catch (err) {
      progressEl.classList.remove('visible');
      this._setStatus('Warp failed: ' + err.message);
    }
  }

  _runWarp(srcData, sw, sh, transform, ow, oh, onProgress) {
    return new Promise((resolve, reject) => {
      if (this.worker) this.worker.terminate();

      // Inline worker code as Blob to avoid file:// CORS restrictions
      const workerCode = `
self.onmessage = function(e) {
  var d = e.data, src = d.sourceData, sw = d.sourceWidth, sh = d.sourceHeight;
  var M = d.transform, ow = d.outputWidth, oh = d.outputHeight;
  var det = M[0]*(M[4]*M[8]-M[5]*M[7]) - M[1]*(M[3]*M[8]-M[5]*M[6]) + M[2]*(M[3]*M[7]-M[4]*M[6]);
  if (Math.abs(det) < 1e-12) { self.postMessage({error:'Singular matrix'}); return; }
  var id = 1/det;
  var inv = [
    (M[4]*M[8]-M[5]*M[7])*id, (M[2]*M[7]-M[1]*M[8])*id, (M[1]*M[5]-M[2]*M[4])*id,
    (M[5]*M[6]-M[3]*M[8])*id, (M[0]*M[8]-M[2]*M[6])*id, (M[2]*M[3]-M[0]*M[5])*id,
    (M[3]*M[7]-M[4]*M[6])*id, (M[1]*M[6]-M[0]*M[7])*id, (M[0]*M[4]-M[1]*M[3])*id
  ];
  var out = new Uint8ClampedArray(ow * oh * 4);
  var sw1 = sw-1, sh1 = sh-1;
  for (var oy = 0; oy < oh; oy++) {
    for (var ox = 0; ox < ow; ox++) {
      var w = inv[6]*ox + inv[7]*oy + inv[8];
      if (Math.abs(w) < 1e-12) continue;
      var sx = (inv[0]*ox + inv[1]*oy + inv[2]) / w;
      var sy = (inv[3]*ox + inv[4]*oy + inv[5]) / w;
      var cx = Math.max(0, Math.min(sw1, sx));
      var cy = Math.max(0, Math.min(sh1, sy));
      var x0 = Math.floor(cx), y0 = Math.floor(cy);
      var x1 = Math.min(x0+1, sw1), y1 = Math.min(y0+1, sh1);
      var fx = cx-x0, fy = cy-y0, fx1 = 1-fx, fy1 = 1-fy;
      var w00=fx1*fy1, w10=fx*fy1, w01=fx1*fy, w11=fx*fy;
      var i00=(y0*sw+x0)*4, i10=(y0*sw+x1)*4, i01=(y1*sw+x0)*4, i11=(y1*sw+x1)*4;
      var oi = (oy*ow+ox)*4;
      out[oi]   = src[i00]*w00 + src[i10]*w10 + src[i01]*w01 + src[i11]*w11;
      out[oi+1] = src[i00+1]*w00 + src[i10+1]*w10 + src[i01+1]*w01 + src[i11+1]*w11;
      out[oi+2] = src[i00+2]*w00 + src[i10+2]*w10 + src[i01+2]*w01 + src[i11+2]*w11;
      out[oi+3] = 255;
    }
    if (oy % 100 === 0) self.postMessage({progress: oy/oh});
  }
  self.postMessage({result: out, width: ow, height: oh}, [out.buffer]);
};`;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);

      this.worker.onmessage = e => {
        if (e.data.error) { reject(new Error(e.data.error)); return; }
        if (e.data.progress !== undefined) { onProgress(e.data.progress); return; }
        if (e.data.result) { resolve(e.data.result); }
      };
      this.worker.onerror = err => reject(err);
      const buf = new Uint8ClampedArray(srcData);
      this.worker.postMessage({
        sourceData: buf, sourceWidth: sw, sourceHeight: sh,
        transform: Array.from(transform), outputWidth: ow, outputHeight: oh
      }, [buf.buffer]);
    });
  }

  // ── Guide import/export ──
  _importGuides() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = () => { if (inp.files[0]) this._loadGuideFile(inp.files[0]); };
    inp.click();
  }

  _exportGuides() {
    if (!this.ui.guides.v1) { this._setStatus('No guides to export.'); return; }
    const blob = new Blob([JSON.stringify(this.ui.guides, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const baseName = this._sourceBaseName || 'guides';
    a.download = `${baseName}_perspective.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this._setStatus('Guides exported.');
  }

  // ── Status helpers ──
  _setStatus(msg) { document.getElementById('status-text').textContent = msg; }
  _updateZoom() { document.getElementById('status-zoom').textContent = Math.round(this.ui.viewScale*100)+'%'; }
  _updateDims() { document.getElementById('status-dims').textContent = this.ui.imgW+'×'+this.ui.imgH; }
  _updateAngles() {
    if (!this.ui.guides.v1) return;
    const a = this.ui.getAngles();
    for (const k of GUIDE_ORDER) {
      const el = document.getElementById('angle-'+k);
      if (el && a[k] !== null) el.textContent = a[k].toFixed(1)+'°';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
