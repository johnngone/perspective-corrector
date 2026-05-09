/**
 * auto-detect.js — Canny + Hough line detection in a Web Worker.
 * Returns 4 guide lines (v1, v2, h1, h2) from dominant image edges.
 */

function buildDetectWorkerCode() {
  return `
self.onmessage = function(e) {
  var rgba = e.data.imageData, w = e.data.width, h = e.data.height, n = w * h;
  self.postMessage({progress: 0.05});

  // Grayscale
  var gray = new Float32Array(n);
  for (var i = 0; i < n; i++) { var j = i*4; gray[i] = 0.299*rgba[j] + 0.587*rgba[j+1] + 0.114*rgba[j+2]; }
  self.postMessage({progress: 0.12});

  // Gaussian blur 5x5
  var K = [2,4,5,4,2, 4,9,12,9,4, 5,12,15,12,5, 4,9,12,9,4, 2,4,5,4,2];
  var bl = new Float32Array(n);
  for (var y = 2; y < h-2; y++) for (var x = 2; x < w-2; x++) {
    var s = 0; for (var ky = -2; ky <= 2; ky++) for (var kx = -2; kx <= 2; kx++)
      s += gray[(y+ky)*w+x+kx] * K[(ky+2)*5+kx+2];
    bl[y*w+x] = s / 159;
  }
  self.postMessage({progress: 0.22});

  // Sobel gradients
  var mag = new Float32Array(n), dir = new Float32Array(n);
  for (var y = 1; y < h-1; y++) for (var x = 1; x < w-1; x++) {
    var i = y*w+x;
    var gx = -bl[(y-1)*w+x-1]+bl[(y-1)*w+x+1]-2*bl[y*w+x-1]+2*bl[y*w+x+1]-bl[(y+1)*w+x-1]+bl[(y+1)*w+x+1];
    var gy = -bl[(y-1)*w+x-1]-2*bl[(y-1)*w+x]-bl[(y-1)*w+x+1]+bl[(y+1)*w+x-1]+2*bl[(y+1)*w+x]+bl[(y+1)*w+x+1];
    mag[i] = Math.sqrt(gx*gx+gy*gy); dir[i] = Math.atan2(gy, gx);
  }
  self.postMessage({progress: 0.32});

  // Auto-threshold (percentile-based) - lowered to pick up weaker lines
  var ms = []; for (var i = 0; i < n; i++) if (mag[i] > 0) ms.push(mag[i]);
  ms.sort(function(a,b){return a-b});
  var hiT = ms[Math.floor(ms.length*0.80)] || 40, loT = hiT * 0.3;

  // Non-maximum suppression (ignore outer 2% margin to prevent hugging image edges)
  var nms = new Float32Array(n);
  var marginX = Math.floor(w * 0.02), marginY = Math.floor(h * 0.02);
  for (var y = Math.max(1, marginY); y < Math.min(h-1, h-marginY); y++) {
    for (var x = Math.max(1, marginX); x < Math.min(w-1, w-marginX); x++) {
      var i = y*w+x, m = mag[i]; if (m < loT) continue;
      var a = ((dir[i]*180/Math.PI)+180)%180, m1=0, m2=0;
      if (a<22.5||a>=157.5){m1=mag[i+1];m2=mag[i-1];}
      else if(a<67.5){m1=mag[(y-1)*w+x+1];m2=mag[(y+1)*w+x-1];}
      else if(a<112.5){m1=mag[(y-1)*w+x];m2=mag[(y+1)*w+x];}
      else{m1=mag[(y-1)*w+x-1];m2=mag[(y+1)*w+x+1];}
      nms[i] = (m>=m1&&m>=m2) ? m : 0;
    }
  }
  self.postMessage({progress: 0.42});

  // Hysteresis edge linking
  var edges = new Uint8Array(n), stk = [];
  for (var i = 0; i < n; i++) {
    if (nms[i]>=hiT){edges[i]=2;stk.push(i);} else if(nms[i]>=loT){edges[i]=1;}
  }
  while (stk.length) {
    var idx=stk.pop(), ex=idx%w, ey=(idx/w)|0;
    for (var dy=-1;dy<=1;dy++) for (var dx=-1;dx<=1;dx++) {
      var nx=ex+dx,ny=ey+dy;
      if(nx>=0&&nx<w&&ny>=0&&ny<h){var ni=ny*w+nx;if(edges[ni]===1){edges[ni]=2;stk.push(ni);}}
    }
  }
  self.postMessage({progress: 0.52});

  // Hough line transform
  var diag = Math.ceil(Math.sqrt(w*w+h*h)), tS=180, rS=2*diag+1;
  var acc = new Uint32Array(tS*rS);
  var cosT=new Float64Array(tS), sinT=new Float64Array(tS);
  for (var t=0;t<tS;t++){var th=t*Math.PI/tS;cosT[t]=Math.cos(th);sinT[t]=Math.sin(th);}
  for (var y=0;y<h;y++) for (var x=0;x<w;x++) {
    if(edges[y*w+x]<2) continue;
    for(var t=0;t<tS;t++){var rho=Math.round(x*cosT[t]+y*sinT[t])+diag;acc[t*rS+rho]++;}
  }
  self.postMessage({progress: 0.72});

  // Find peaks (local maxima) - lowered min votes to detect shorter/fainter lines
  var peaks=[], minV=Math.max(15, Math.min(w,h)*0.045), ns=10;
  for (var t=0;t<tS;t++) for (var r=0;r<rS;r++) {
    var v=acc[t*rS+r]; if(v<minV) continue;
    var ok=true;
    for(var dt=-ns;dt<=ns&&ok;dt++) for(var dr=-ns;dr<=ns&&ok;dr++){
      if(!dt&&!dr) continue;
      var nt=((t+dt)%tS+tS)%tS, nr=r+dr;
      if(nr>=0&&nr<rS&&acc[nt*rS+nr]>v) ok=false;
    }
    if(ok) peaks.push({theta:t*Math.PI/tS, rho:r-diag, votes:v});
  }
  peaks.sort(function(a,b){return b.votes-a.votes});
  self.postMessage({progress: 0.85});

  // Classify: vertical (theta<30 or >150 deg) vs horizontal (60-120 deg)
  var vL=[], hL=[];
  for (var i=0;i<peaks.length;i++){
    var deg=peaks[i].theta*180/Math.PI;
    if(deg<35||deg>145) vL.push(peaks[i]);
    else if(deg>55&&deg<125) hL.push(peaks[i]);
  }

  // Pick 2 well-separated lines from each group
  function pickTwo(lines, minSep) {
    if(lines.length<2) return lines.length ? [lines[0], lines[0]] : null;
    var a = lines[0];
    for (var i=1;i<lines.length;i++) {
      if(Math.abs(lines[i].rho - a.rho) > minSep) return [a, lines[i]];
    }
    return [a, lines[lines.length > 1 ? 1 : 0]];
  }

  var v2 = pickTwo(vL, w*0.15), h2 = pickTwo(hL, h*0.15);
  if (!v2 || !h2) { self.postMessage({error:'Could not detect enough lines. Try adjusting guides manually.'}); return; }

  // Convert (rho,theta) line to 2 endpoints clipped to image
  function lineToEndpoints(rho, theta, w, h) {
    var ct=Math.cos(theta), st=Math.sin(theta), pts=[];
    if(Math.abs(ct)>1e-6){var x0=rho/ct; if(x0>=0&&x0<w) pts.push([x0,0]);}
    if(Math.abs(ct)>1e-6){var x1=(rho-(h-1)*st)/ct; if(x1>=0&&x1<w) pts.push([x1,h-1]);}
    if(Math.abs(st)>1e-6){var y0=rho/st; if(y0>=0&&y0<h) pts.push([0,y0]);}
    if(Math.abs(st)>1e-6){var y1=(rho-(w-1)*ct)/st; if(y1>=0&&y1<h) pts.push([w-1,y1]);}
    // Deduplicate close points
    var unique = [pts[0]];
    for(var i=1;i<pts.length;i++){
      var dup=false;
      for(var j=0;j<unique.length;j++) if(Math.hypot(pts[i][0]-unique[j][0],pts[i][1]-unique[j][1])<2) dup=true;
      if(!dup) unique.push(pts[i]);
    }
    if(unique.length<2) unique.push(unique[0]);
    return [unique[0], unique[1]];
  }

  // Sort so v1 is left, v2 is right; h1 is top, h2 is bottom
  if(v2[0].rho > v2[1].rho) { var tmp=v2[0]; v2[0]=v2[1]; v2[1]=tmp; }
  if(h2[0].rho > h2[1].rho) { var tmp=h2[0]; h2[0]=h2[1]; h2[1]=tmp; }

  var guides = {
    v1: lineToEndpoints(v2[0].rho, v2[0].theta, w, h),
    v2: lineToEndpoints(v2[1].rho, v2[1].theta, w, h),
    h1: lineToEndpoints(h2[0].rho, h2[0].theta, w, h),
    h2: lineToEndpoints(h2[1].rho, h2[1].theta, w, h)
  };

  self.postMessage({progress: 1, guides: guides});
};`;
}

/**
 * Run auto-detection on an image. Returns a Promise that resolves with guide coords.
 * @param {HTMLImageElement} image
 * @param {number} imgW - original width
 * @param {number} imgH - original height
 * @param {function} onProgress - called with 0..1
 * @returns {Promise<{v1,v2,h1,h2}>} guides in original image coordinates
 */
function runAutoDetect(image, imgW, imgH, onProgress) {
  return new Promise(function(resolve, reject) {
    // Downsample for speed (max 800px)
    var maxDim = 800;
    var scale = Math.min(1, maxDim / Math.max(imgW, imgH));
    var sw = Math.round(imgW * scale), sh = Math.round(imgH * scale);

    var tmp = document.createElement('canvas');
    tmp.width = sw; tmp.height = sh;
    var ctx = tmp.getContext('2d');
    ctx.drawImage(image, 0, 0, sw, sh);
    var imgData = ctx.getImageData(0, 0, sw, sh);

    var blob = new Blob([buildDetectWorkerCode()], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    var worker = new Worker(url);
    URL.revokeObjectURL(url);

    worker.onmessage = function(e) {
      if (e.data.progress !== undefined) { onProgress(e.data.progress); }
      if (e.data.error) { worker.terminate(); reject(new Error(e.data.error)); }
      if (e.data.guides) {
        worker.terminate();
        // Scale guides back to original coordinates
        var inv = 1 / scale, g = e.data.guides;
        var result = {};
        ['v1','v2','h1','h2'].forEach(function(k) {
          result[k] = [
            [g[k][0][0]*inv, g[k][0][1]*inv],
            [g[k][1][0]*inv, g[k][1][1]*inv]
          ];
        });
        resolve(result);
      }
    };
    worker.onerror = function(err) { worker.terminate(); reject(err); };
    worker.postMessage({ imageData: imgData.data, width: sw, height: sh }, [imgData.data.buffer]);
  });
}
