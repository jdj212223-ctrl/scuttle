/* Scuttle pets: original pixel-art buddies + the crawling engine.
 * Sprites are drawn as LEFT halves (8 columns) and mirrored, so they stay symmetric.
 * Letters:  . empty   o outline   b body (your colour)   l light body   d dark body
 *           e eye (2 rows tall)   m mouth   p cheek pink   y yellow   w white
 */
(function () {
  const PETS = {
    blob: {
      label: 'Blob', defaultName: 'Gloop', defaultColor: '#7ad7a8', bob: true,
      rows: [
        '........', '....oooo', '...obbbb', '..obllbb', '.obblbbb', '.obbbbbb', 'obbbebbb',
        'obbbebbb', 'obpbbbbm', 'obbbbbbb', 'obbbbbbb', '.obbbbbb', '..oooooo',
      ],
    },
    cat: {
      label: 'Cat', defaultName: 'Biscuit', defaultColor: '#f2b866',
      rows: [
        '.o......', '.oo.....', '.obo....', '.obboooo', '.obbbbbb', 'obbbbbbb', 'obbebbbb',
        'obbebbbb', 'obpbbbbm', '.obbbbbb', '..obbbbb', '.obbdbbb', '.obbbdbb', '..oooooo',
      ],
      legs: ['..o..o..', '...o..o.'],
    },
    cloud: {
      label: 'Cloud', defaultName: 'Puff', defaultColor: '#dfe8ff', bob: true,
      rows: [
        '........', '....ooo.', '...obbbo', '.oobbbbb', 'obbllbbb', 'obbbebbb', 'obbbebbb',
        'obpbbbbm', 'obbbbbbb', '.obbbbbb', '..oooooo',
      ],
    },
    robot: {
      label: 'Robot', defaultName: 'Bolt', defaultColor: '#9aa7ff',
      rows: [
        '.......o', '......oy', '.......o', '..oooooo', '..olllll', '..obbbbb', '..obebbb',
        'oobbebbb', '..obbbbb', '..obbmmm', '..obbbbb', '..oooooo', '...obdbb', '...obbyb', '...ooooo',
      ],
      legs: ['....o...', '.....o..'],
    },
    crab: {
      label: 'Crab', defaultName: 'Pinch', defaultColor: '#4fb7e8',
      rows: [
        '.oo.....', 'obbo....', 'o.bo....', 'obbo....', '.oo.oooo', '..oobbbb', '..obllbb',
        '.obbebbb', 'obbbebbb', 'obpbbbbm', '.obbbbbb', '..oooooo',
      ],
      legs: ['.o.o.o..', 'o.o.o...'],
    },
  };

  function shade(hex, f) {
    const n = parseInt(hex.replace('#', ''), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mix = (c) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f));
    r = mix(r); g = mix(g); b = mix(b);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  function fullRows(spec, frame) {
    const half = spec.rows.slice();
    if (spec.legs) half.push(spec.legs[frame % spec.legs.length]);
    return half.map((h) => h + h.split('').reverse().join(''));
  }
  /** Draw one frame. mood: normal|blink|sleep|happy|panic|cheer */
  function draw(ctx, kind, color, frame, mood) {
    const spec = PETS[kind] || PETS.blob;
    const rows = fullRows(spec, frame);
    const pal = {
      o: shade(color, -0.62), b: color, l: shade(color, 0.45), d: shade(color, -0.2), e: '#14121f',
      m: '#14121f', p: '#ff8fb1', y: '#ffd84a', w: '#ffffff',
    };
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // top / bottom row of each eye column
    const eyeTop = {};
    rows.forEach((r, y) => r.split('').forEach((c, x) => { if (c === 'e' && eyeTop[x] === undefined) eyeTop[x] = y; }));
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) {
        let c = r[x];
        if (c === '.') continue;
        let col = pal[c];
        if (c === 'e') {
          const top = eyeTop[x] === y;
          if (mood === 'sleep' || mood === 'blink') col = top ? pal.b : pal.e;
          else if (mood === 'happy' || mood === 'cheer') col = top ? pal.e : pal.b;
          else if (mood === 'panic') col = top ? pal.w : pal.e;
        }
        if (c === 'm') {
          if (mood === 'happy' || mood === 'cheer') col = '#d9466f';
          else if (mood === 'sleep') col = pal.b;
        }
        ctx.fillStyle = col;
        ctx.fillRect(x, y, 1, 1);
      }
    });
    if (mood === 'panic') { // sweat drop
      ctx.fillStyle = '#7fd3ff';
      ctx.fillRect(14, 1, 1, 1); ctx.fillRect(13, 2, 2, 2);
    }
    return rows.length;
  }
  function spriteHeight(kind) { const s = PETS[kind] || PETS.blob; return s.rows.length + (s.legs ? 1 : 0); }

  const BUBBLES = {
    sleep: ['z', 'z z', 'z z z'],
    happy: ['♥', 'yay!', '♪', 'saved! ♥'],
    panic: ['!!', 'eek!', 'an error?!', 'AAA'],
    cheer: ['pushed! 🎉', 'woo!', 'to the cloud ☁️'],
    pet: ['♥', 'hehe', 'purr…', ':)'],
  };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  /** A pet that crawls around the edges of `host` (an element, or the window when host = document.body). */
  class Pet {
    constructor(host, opts) {
      this.host = host;
      this.opts = Object.assign({ kind: 'blob', color: '#7ad7a8', name: 'Gloop', size: 4, climb: true }, opts || {});
      this.el = document.createElement('div');
      this.el.className = 'scuttle-pet';
      this.el.style.cssText = 'position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;will-change:transform;z-index:50;';
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'display:block;image-rendering:pixelated;image-rendering:crisp-edges;';
      this.el.appendChild(this.canvas);
      this.bubble = document.createElement('div');
      this.bubble.className = 'scuttle-pet-bubble';
      this.bubble.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:51;opacity:0;transition:opacity .25s;' +
        'font:600 12px/1.2 -apple-system,system-ui,sans-serif;color:#1d1b2c;background:#fff;border:2px solid #1d1b2c;' +
        'border-radius:9px;padding:3px 7px;white-space:nowrap;box-shadow:2px 2px 0 rgba(0,0,0,.25);';
      this.ctx = this.canvas.getContext('2d');
      this.p = 20; this.dir = 1; this.mood = 'walk'; this.moodUntil = 0; this.frame = 0; this.frameT = 0;
      this.pauseUntil = 0; this.lastActivity = performance.now(); this.blinkAt = performance.now() + 2500;
      this.bubbleUntil = 0; this.hop = 0; this.alive = false; this.listeners = {};
      this.el.addEventListener('click', (e) => { e.stopPropagation(); this.react('pet'); this.emit('click'); });
      this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.emit('menu', e); });
      this.el.addEventListener('mouseenter', () => this.emit('hover', true));
      this.el.addEventListener('mouseleave', () => this.emit('hover', false));
      this.applyOpts();
    }
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, a) { (this.listeners[ev] || []).forEach((f) => f(a)); }
    applyOpts(o) {
      if (o) Object.assign(this.opts, o);
      const h = spriteHeight(this.opts.kind);
      this.canvas.width = 16; this.canvas.height = h;
      const s = Math.max(1, Math.min(10, +this.opts.size || 4));
      this.w = 16 * s; this.h = h * s;
      this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
      this.el.style.width = this.w + 'px'; this.el.style.height = this.h + 'px';
      this.el.title = this.opts.name || '';
      this.render();
    }
    show() {
      if (this.alive) return;
      this.alive = true;
      this.host.appendChild(this.el); this.host.appendChild(this.bubble);
      this.lastActivity = performance.now();
      this.p = Math.random() * Math.max(1, this.bounds().W - this.w);
      this.say(`hi! I'm ${this.opts.name || 'your pet'}`, 3000);
      this.last = performance.now();
      const loop = (t) => { if (!this.alive) return; this.tick(t); this.raf = requestAnimationFrame(loop); };
      this.raf = requestAnimationFrame(loop);
    }
    hide() {
      this.alive = false; cancelAnimationFrame(this.raf);
      this.el.remove(); this.bubble.remove();
    }
    activity() { // the user typed something
      this.lastActivity = performance.now();
      if (this.mood === 'sleep') { this.setMood('walk'); this.say('huh? oh hi!', 1800); }
    }
    react(kind) {
      if (!this.alive) return;
      this.lastActivity = performance.now();
      const dur = { happy: 2600, panic: 3200, cheer: 4500, pet: 1800 }[kind] || 2000;
      this.setMood(kind === 'pet' ? 'happy' : kind, dur);
      this.say(pick(BUBBLES[kind] || ['!']), dur);
    }
    setMood(m, dur) { this.mood = m; this.moodUntil = dur ? performance.now() + dur : 0; }
    say(text, ms) { this.bubble.textContent = text; this.bubble.style.opacity = '1'; this.bubbleUntil = performance.now() + (ms || 2000); }
    bounds() {
      const r = this.host === document.body ? { width: innerWidth, height: innerHeight } : this.host.getBoundingClientRect();
      return { W: r.width, H: r.height };
    }
    segs() {
      const { W, H } = this.bounds();
      const lb = Math.max(1, W - this.w), lv = Math.max(1, H - this.w);
      return this.opts.climb ? [lb, lv, lb, lv] : [lb];
    }
    // perimeter position -> centre point + angle. order: bottom(L->R), right(up), top(R->L), left(down)
    place(p) {
      const { W, H } = this.bounds();
      const [lb, lv] = [Math.max(1, W - this.w), Math.max(1, H - this.w)];
      const w = this.w, h = this.h;
      if (!this.opts.climb) return { cx: Math.min(lb, Math.max(0, p)) + w / 2, cy: H - h / 2, ang: 0, nx: 0, ny: -1 };
      if (p < lb) return { cx: p + w / 2, cy: H - h / 2, ang: 0, nx: 0, ny: -1 };
      p -= lb;
      if (p < lv) return { cx: W - h / 2, cy: H - w / 2 - p, ang: -90, nx: -1, ny: 0 };
      p -= lv;
      if (p < lb) return { cx: W - w / 2 - p, cy: h / 2, ang: 180, nx: 0, ny: 1 };
      p -= lb;
      return { cx: h / 2, cy: w / 2 + Math.min(p, lv), ang: 90, nx: 1, ny: 0 };
    }
    tick(t) {
      const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
      if (this.moodUntil && t > this.moodUntil) { this.moodUntil = 0; this.mood = 'walk'; }
      if (this.mood !== 'sleep' && t - this.lastActivity > 45000) { this.setMood('sleep'); }
      const segs = this.segs(); const P = segs.reduce((a, b) => a + b, 0);
      let speed = 0;
      if (this.mood === 'walk') {
        if (t < this.pauseUntil) speed = 0;
        else {
          speed = 38;
          if (Math.random() < dt * 0.25) this.pauseUntil = t + 800 + Math.random() * 2200; // stop to look around
          if (Math.random() < dt * 0.08) this.dir *= -1;
        }
      } else if (this.mood === 'panic') speed = 150;
      else if (this.mood === 'happy') speed = 0;
      else if (this.mood === 'cheer') speed = 20;
      // move along the edges
      if (speed) {
        let np = this.p + this.dir * speed * dt;
        if (!this.opts.climb) {
          if (np < 0 || np > segs[0]) { this.dir *= -1; np = Math.max(0, Math.min(segs[0], np)); }
        } else {
          const lb = segs[0];
          const onBottom = this.p >= 0 && this.p <= lb;
          // leaving the floor: sometimes climb, otherwise turn around
          if (onBottom && (np > lb || np < 0)) {
            const climb = this.mood === 'panic' ? Math.random() < 0.8 : Math.random() < 0.4;
            if (!climb) { this.dir *= -1; np = Math.max(0, Math.min(lb, np)); }
          }
          np = ((np % P) + P) % P;
          // on the ceiling, walk home a bit faster by preferring the shorter way down
        }
        this.p = np;
      }
      // animation
      this.frameT += dt;
      const step = this.mood === 'panic' ? 0.08 : 0.2;
      if (this.frameT > step) { this.frameT = 0; if (speed) this.frame++; }
      if (this.mood === 'happy' || this.mood === 'cheer') this.hop = Math.abs(Math.sin(t / (this.mood === 'cheer' ? 120 : 160))) * this.h * 0.35;
      else if (this.mood === 'panic') this.hop = Math.random() * 2;
      else this.hop = 0;
      let face = this.mood === 'walk' ? (t > this.blinkAt ? 'blink' : 'normal') : this.mood;
      if (t > this.blinkAt + 140) this.blinkAt = t + 2000 + Math.random() * 3500;
      if (this.mood === 'sleep' && t > this.bubbleUntil) this.say(BUBBLES.sleep[Math.floor(t / 700) % 3], 800);
      this.face = face;
      this.render();
      // position
      const g = this.place(this.p);
      const spec = PETS[this.opts.kind] || PETS.blob;
      const bob = spec.bob && speed && (this.frame % 2) ? this.h / 16 : 0;
      this.el.style.transform = `translate(${g.cx - this.w / 2}px, ${g.cy - this.h / 2}px) rotate(${g.ang}deg) scaleX(${this.dir}) translateY(${-(this.hop + bob)}px)`;
      // speech bubble: nudged toward the middle of the screen
      if (t > this.bubbleUntil) this.bubble.style.opacity = '0';
      const bw = this.bubble.offsetWidth, bh = this.bubble.offsetHeight;
      const d = Math.max(this.w, this.h) / 2 + 10 + this.hop;
      const { W, H } = this.bounds();
      let bx = g.cx + g.nx * (d + bw / 2) - bw / 2, by = g.cy + g.ny * (d + bh / 2) - bh / 2;
      bx = Math.max(4, Math.min(W - bw - 4, bx)); by = Math.max(4, Math.min(H - bh - 4, by));
      this.bubble.style.transform = `translate(${bx}px, ${by}px)`;
    }
    render() { draw(this.ctx, this.opts.kind, this.opts.color, this.frame, this.face || 'normal'); }
  }

  window.ScuttlePets = { PETS, draw, spriteHeight, Pet };
})();
