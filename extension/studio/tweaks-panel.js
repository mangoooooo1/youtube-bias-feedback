class TweaksPanel {
  /**
   * @param {object} opts
   * @param {string}   opts.title      - Panel header title
   * @param {object}   opts.defaults   - Initial tweak values
   * @param {Function} opts.onChange   - Called with (key, value) on any change
   */
  constructor({ title = "Tweaks", defaults = {}, onChange = () => {} } = {}) {
    this.title = title;
    this.state = { ...defaults };
    this.onChange = onChange;
    this._el = null;
    this._offset = { x: 16, y: 16 };
    this._open = false;
    this._init();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    this.state[key] = value;
    this.onChange(key, value);
    this._syncControls();
  }

  open() {
    this._el.style.display = "flex";
    this._open = true;
  }
  close() {
    this._el.style.display = "none";
    this._open = false;
  }
  toggle() {
    this._open ? this.close() : this.open();
  }

  /** Add a section header */
  addSection(label) {
    const d = document.createElement("div");
    d.className = "twk-sect";
    d.textContent = label;
    this._body.appendChild(d);
    return this;
  }

  /** Segmented radio (≤3 short options) or select fallback */
  addRadio(label, key, options) {
    const labelLen = (o) => String(typeof o === "object" ? o.label : o).length;
    const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
    const fits = maxLen <= ({ 2: 16, 3: 10 }[options.length] ?? 0);
    if (!fits) return this.addSelect(label, key, options);

    const opts = options.map((o) =>
      typeof o === "object" ? o : { value: o, label: o },
    );
    const row = this._row(label);
    const seg = document.createElement("div");
    seg.className = "twk-seg";
    seg.dataset.key = key;

    const thumb = document.createElement("div");
    thumb.className = "twk-seg-thumb";
    seg.appendChild(thumb);

    opts.forEach((o, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = o.label;
      btn.dataset.val = o.value;
      btn.addEventListener("click", () => this.set(key, o.value));
      seg.appendChild(btn);
    });

    row.appendChild(seg);
    this._body.appendChild(row);
    this._syncSeg(seg, key, opts);
    return this;
  }

  /** Dropdown select */
  addSelect(label, key, options) {
    const opts = options.map((o) =>
      typeof o === "object" ? o : { value: o, label: o },
    );
    const row = this._row(label);
    const sel = document.createElement("select");
    sel.className = "twk-field";
    sel.dataset.key = key;
    opts.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = this.state[key];
    sel.addEventListener("change", () => this.set(key, sel.value));
    row.appendChild(sel);
    this._body.appendChild(row);
    return this;
  }

  /** Toggle switch */
  addToggle(label, key) {
    const row = document.createElement("div");
    row.className = "twk-row twk-row-h";
    const lbl = document.createElement("div");
    lbl.className = "twk-lbl";
    const sp = document.createElement("span");
    sp.textContent = label;
    lbl.appendChild(sp);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "twk-toggle";
    btn.dataset.key = key;
    btn.dataset.on = this.state[key] ? "1" : "0";
    btn.innerHTML = "<i></i>";
    btn.addEventListener("click", () => this.set(key, !this.state[key]));
    row.appendChild(lbl);
    row.appendChild(btn);
    this._body.appendChild(row);
    return this;
  }

  /** Action button */
  addButton(label, onClick, secondary = false) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = secondary ? "twk-btn secondary" : "twk-btn";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    this._body.appendChild(btn);
    return this;
  }

  /** Hint text */
  addHint(text) {
    const p = document.createElement("p");
    p.style.cssText =
      "margin:0;font-size:10.5px;color:rgba(41,38,27,.5);line-height:1.5";
    p.textContent = text;
    this._body.appendChild(p);
    return this;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _init() {
    const panel = document.createElement("div");
    panel.className = "twk-panel";
    panel.style.cssText = `right:${this._offset.x}px;bottom:${this._offset.y}px;display:none`;

    const hd = document.createElement("div");
    hd.className = "twk-hd";
    hd.innerHTML = `<b>${this.title}</b>`;
    const xBtn = document.createElement("button");
    xBtn.className = "twk-x";
    xBtn.textContent = "✕";
    xBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    xBtn.addEventListener("click", () => this.close());
    hd.appendChild(xBtn);

    const body = document.createElement("div");
    body.className = "twk-body";

    panel.appendChild(hd);
    panel.appendChild(body);
    document.body.appendChild(panel);

    this._el = panel;
    this._body = body;
    this._makeDraggable(hd, panel);
  }

  _row(label) {
    const row = document.createElement("div");
    row.className = "twk-row";
    const lbl = document.createElement("div");
    lbl.className = "twk-lbl";
    const sp = document.createElement("span");
    sp.textContent = label;
    lbl.appendChild(sp);
    row.appendChild(lbl);
    return row;
  }

  _syncControls() {
    // Sync selects
    this._body.querySelectorAll("select[data-key]").forEach((el) => {
      el.value = this.state[el.dataset.key];
    });
    // Sync toggles
    this._body.querySelectorAll(".twk-toggle[data-key]").forEach((el) => {
      el.dataset.on = this.state[el.dataset.key] ? "1" : "0";
    });
    // Sync segmented radios
    this._body.querySelectorAll(".twk-seg[data-key]").forEach((seg) => {
      const opts = Array.from(seg.querySelectorAll("button")).map((b) => ({
        value: b.dataset.val,
      }));
      this._syncSeg(seg, seg.dataset.key, opts);
    });
  }

  _syncSeg(seg, key, opts) {
    const idx = Math.max(
      0,
      opts.findIndex((o) => String(o.value) === String(this.state[key])),
    );
    const n = opts.length;
    const thumb = seg.querySelector(".twk-seg-thumb");
    thumb.style.left = `calc(2px + ${idx} * (100% - 4px) / ${n})`;
    thumb.style.width = `calc((100% - 4px) / ${n})`;
  }

  _makeDraggable(handle, panel) {
    const PAD = 16;
    const clamp = () => {
      const w = panel.offsetWidth,
        h = panel.offsetHeight;
      const maxR = Math.max(PAD, window.innerWidth - w - PAD);
      const maxB = Math.max(PAD, window.innerHeight - h - PAD);
      this._offset.x = Math.min(maxR, Math.max(PAD, this._offset.x));
      this._offset.y = Math.min(maxB, Math.max(PAD, this._offset.y));
      panel.style.right = this._offset.x + "px";
      panel.style.bottom = this._offset.y + "px";
    };
    handle.addEventListener("mousedown", (e) => {
      const r = panel.getBoundingClientRect();
      const sx = e.clientX,
        sy = e.clientY;
      const startR = window.innerWidth - r.right;
      const startB = window.innerHeight - r.bottom;
      const move = (ev) => {
        this._offset = {
          x: startR - (ev.clientX - sx),
          y: startB - (ev.clientY - sy),
        };
        clamp();
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    window.addEventListener("resize", clamp);
  }
}

window.TweaksPanel = TweaksPanel;
