/**
 * temp-slider-row
 *
 * A Lovelace entity ROW with a slider that only moves when you grab the thumb.
 *
 * Why this exists: thomasloven's slider-entity-row renders a native <ha-slider>,
 * i.e. an <input type="range">. Tapping anywhere on a range input jumps the thumb
 * to that point - that is browser behaviour, not a setting, so no config or CSS can
 * turn it off. On a phone that means scrolling past a list of sliders changes them.
 * This row draws its own track and thumb and handles pointer events itself.
 *
 * Behaviour:
 *   - a drag starts ONLY if the pointer lands within GRAB_PX of the thumb
 *   - touching the track does nothing at all
 *   - vertical movement is never captured, so the page scrolls normally
 *   - the value updates live while dragging, but ONE service call is sent on release
 *
 * Supports climate.* (target temperature) and input_number.*.
 */

const GRAB_PX = 24;      // touch-friendly grab radius around the thumb
const VERSION = "1.2.2";

class TempSliderRow extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._dragging = false;
    this._dragValue = null;
    this._built = false;
    this._escHandler = (e) => { if (e.key === "Escape") this._closePop(); };
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error("temp-slider-row: 'entity' is required");
    const domain = config.entity.split(".")[0];
    if (!["climate", "input_number", "number", "water_heater"].includes(domain)) {
      throw new Error(`temp-slider-row: unsupported domain '${domain}'`);
    }
    this._config = {
      min: null, max: null, step: null,
      show_value: true, unit: "°", height: null,
      profile: null, heating_master: null, ac_master: null, offset_entity: null,
      ...config,
    };
    this._build();
  }

  static getConfigElement() { return document.createElement("temp-slider-row-editor"); }
  static getStubConfig() { return { type: "custom:temp-slider-row", entity: "" }; }

  set hass(hass) {
    this._hass = hass;
    this._subscribe();
    this._render();
  }

  /**
   * The parent entities card only pushes `hass` down when IT updates, and it decides that from the
   * entities in its own config - the row's `entity`. This row also depends on heating_master,
   * ac_master and offset_entity, which the card knows nothing about. Because hass objects are
   * immutable snapshots, a change to one of those left this element holding a STALE snapshot and
   * painting a stale colour, while the template-entity-row beside it (which uses HA's render_template
   * subscription) stayed correct. That is the "orange icon, grey slider" mismatch. So subscribe to
   * state_changed directly and keep our own freshest copy of every entity we care about.
   */
  _deps() {
    return [this._config.entity, this._config.heating_master,
            this._config.ac_master, this._config.offset_entity].filter(Boolean);
  }
  _st(entityId) {
    if (!entityId) return undefined;
    return (this._live && this._live[entityId]) ||
           (this._hass && this._hass.states ? this._hass.states[entityId] : undefined);
  }
  _subscribe() {
    if (this._subPending || this._unsub) return;
    if (!this._hass || !this._hass.connection) return;
    this._subPending = true;
    this._live = this._live || {};
    this._hass.connection.subscribeEvents((ev) => {
      const ns = ev && ev.data && ev.data.new_state;
      if (!ns || !ns.entity_id) return;
      if (this._deps().indexOf(ns.entity_id) === -1) return;
      this._live[ns.entity_id] = ns;
      this._paint();
      if (this._backdrop && !this._backdrop.hidden && !this._popDrag) {
        this._popValue = this._offsetValue; this._paintPop();
      }
    }, "state_changed").then((u) => { this._unsub = u; this._subPending = false; })
      .catch(() => { this._subPending = false; });
  }

  // ---------- entity helpers ----------
  get _stateObj() {
    return this._config ? this._st(this._config.entity) : undefined;
  }
  get _domain() { return this._config.entity.split(".")[0]; }

  _currentValue() {
    const s = this._stateObj;
    if (!s) return null;
    if (this._domain === "climate" || this._domain === "water_heater") {
      const t = s.attributes.temperature;
      return t === undefined || t === null ? null : Number(t);
    }
    const v = Number(s.state);
    return Number.isFinite(v) ? v : null;
  }

  _bounds() {
    const s = this._stateObj;
    const a = (s && s.attributes) || {};
    const c = this._config;
    let min = c.min, max = c.max, step = c.step;
    if (min === null || min === undefined)
      min = a.min_temp !== undefined ? a.min_temp : (a.min !== undefined ? a.min : 7);
    if (max === null || max === undefined)
      max = a.max_temp !== undefined ? a.max_temp : (a.max !== undefined ? a.max : 35);
    if (step === null || step === undefined)
      step = a.target_temp_step !== undefined ? a.target_temp_step : (a.step !== undefined ? a.step : 0.5);
    return { min: Number(min), max: Number(max), step: Number(step) || 0.5 };
  }

  _available() {
    const s = this._stateObj;
    return !!s && s.state !== "unavailable" && s.state !== "unknown";
  }

  // ---------- geometry ----------
  _valueToFrac(v) {
    const { min, max } = this._bounds();
    if (max === min) return 0;
    return Math.min(1, Math.max(0, (v - min) / (max - min)));
  }
  _xToValue(clientX) {
    const r = this._track.getBoundingClientRect();
    const { min, max, step } = this._bounds();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    const raw = min + frac * (max - min);
    const snapped = Math.round(raw / step) * step;
    const dp = (String(step).split(".")[1] || "").length;
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(dp));
  }
  _thumbCenterX() {
    const r = this._track.getBoundingClientRect();
    const v = this._dragging ? this._dragValue : this._currentValue();
    if (v === null) return r.left;
    return r.left + this._valueToFrac(v) * r.width;
  }

  // ---------- interaction ----------
  _onPointerDown(e) {
    if (!this._available()) return;
    if (this._currentValue() === null) return;
    // ONLY engage if the pointer landed on the thumb. Touching the track does nothing.
    if (Math.abs(e.clientX - this._thumbCenterX()) > GRAB_PX) return;

    this._dragging = true;
    this._dragValue = this._currentValue();
    this._root.classList.add("dragging");
    try { this._thumb.setPointerCapture(e.pointerId); } catch (_) {}
    this._haptic("selection");
    e.preventDefault();   // safe now: we know this is a deliberate grab
    e.stopPropagation();
  }

  _onPointerMove(e) {
    if (!this._dragging) return;
    const next = this._xToValue(e.clientX);
    if (next !== this._dragValue) {
      this._dragValue = next;
      this._haptic("selection");
      this._paint();       // live visual feedback, NO service call
    }
    e.preventDefault();
    e.stopPropagation();
  }

  _onPointerUp(e) {
    if (!this._dragging) return;
    this._dragging = false;
    this._root.classList.remove("dragging");
    try { this._thumb.releasePointerCapture(e.pointerId); } catch (_) {}
    const v = this._dragValue;
    this._dragValue = null;
    if (v !== null && v !== this._currentValue()) this._commit(v);   // exactly ONE call
    this._paint();
  }

  _commit(value) {
    const ent = this._config.entity;
    if (this._domain === "climate") {
      this._hass.callService("climate", "set_temperature", { entity_id: ent, temperature: value });
    } else if (this._domain === "water_heater") {
      this._hass.callService("water_heater", "set_temperature", { entity_id: ent, temperature: value });
    } else if (this._domain === "number") {
      this._hass.callService("number", "set_value", { entity_id: ent, value });
    } else {
      this._hass.callService("input_number", "set_value", { entity_id: ent, value });
    }
  }

  _haptic(type) {
    this.dispatchEvent(new CustomEvent("haptic", { bubbles: true, composed: true, detail: type }));
  }


  // ---------- colour ----------
  /**
   * Mirrors the Climate tab's template-entity-row icon colours EXACTLY - the fill and the
   * icon must never disagree. Copied from the live dashboard config, not invented:
   *
   *   radiator  : AC master on OR heating master off OR room off -> disabled
   *               hvac_action 'heating' -> orange ; otherwise (idle) -> secondary
   *   AC zone   : cooling blue / heating deep-orange / fan|drying CYAN / else disabled
   *   thermostat: off disabled / cooling blue / heating deep-orange / else secondary
   *
   * Note fan+drying is CYAN, matching mdi:fan on the existing rows (not green).
   * Idle is deliberately NEUTRAL, never the mode colour - an idle zone reading as
   * "cooling" was a real complaint that the icon logic already fixed.
   */
  _profile() {
    if (this._config.profile) return this._config.profile;
    const e = this._config.entity;
    if (this._domain !== "climate") return "plain";
    if (e.includes("radiator") || this._config.heating_master || this._config.ac_master) return "radiator";
    if (e.startsWith("climate.ac_")) return "zone";
    return "thermostat";
  }

  _modeColor() {
    const DIS    = "var(--disabled-text-color)";
    const SEC    = "var(--secondary-text-color)";
    const ORANGE = "var(--orange-color, #ff9800)";
    const DEEP   = "var(--deep-orange-color, #ff5722)";
    const BLUE   = "var(--blue-color, #2196f3)";
    const CYAN   = "var(--cyan-color, #00bcd4)";
    const s = this._stateObj;
    if (!s) return DIS;
    const prof = this._profile();
    const acS   = this._config.ac_master ? this._st(this._config.ac_master) : null;
    const heatS = this._config.heating_master ? this._st(this._config.heating_master) : null;

    // colour of a climate entity: what it is DOING, falling back to what it is SET to
    const climColor = (st) => {
      const a = st.attributes && st.attributes.hvac_action;
      if (a === "cooling") return BLUE;
      if (a === "heating") return DEEP;
      if (a === "fan" || a === "drying") return CYAN;
      const m = st.state;
      if (m === "cool") return BLUE;
      if (m === "heat") return DEEP;
      if (m === "fan_only" || m === "dry") return CYAN;
      return SEC;
    };

    /**
     * 'master' drives BOTH systems - the radiators via the push automation and the AC
     * zones via the comfort sync - so it is not a heating control that the AC disables.
     * It shows whichever system is actually live, and greys only when neither is.
     */
    if (prof === "master") {
      if (acS && acS.state !== "off") return climColor(acS);       // AC has priority
      if (heatS && heatS.state === "on") return this._config.color || ORANGE;
      return DIS;                                                   // nothing is running
    }

    // every other profile: the masters gate it first
    if (acS && acS.state !== "off") return DIS;       // AC overrides the boiler
    if (heatS && heatS.state !== "on") return DIS;    // heating master off

    if (prof === "plain") return this._config.color || "var(--primary-color, #03a9f4)";

    if (prof === "radiator") {
      if (s.state === "off") return DIS;
      if (s.attributes && s.attributes.hvac_action === "heating") return this._config.color || ORANGE;
      return SEC;
    }

    if (prof === "zone") {
      const a = s.attributes && s.attributes.hvac_action;
      if (a === "cooling") return BLUE;
      if (a === "heating") return DEEP;
      if (a === "fan" || a === "drying") return CYAN;
      return DIS;
    }

    // thermostat (Sensibo etc.)
    if (s.state === "off") return DIS;
    return climColor(s);
  }

  // ---------- offset popup ----------
  get _offsetValue() {
    const o = this._st(this._config.offset_entity);
    const v = o ? parseFloat(o.state) : NaN;
    return isFinite(v) ? v : 0;
  }
  _popBounds() {
    const o = this._st(this._config.offset_entity);
    const a = (o && o.attributes) || {};
    return { min: Number(a.min !== undefined ? a.min : -5),
             max: Number(a.max !== undefined ? a.max : 5),
             step: Number(a.step !== undefined ? a.step : 0.5) || 0.5 };
  }
  _popXToValue(clientX) {
    const r = this._popTrack.getBoundingClientRect();
    const { min, max, step } = this._popBounds();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    const snapped = Math.round((min + frac * (max - min)) / step) * step;
    const dp = (String(step).split(".")[1] || "").length;
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(dp));
  }
  _openPop() {
    document.addEventListener("keydown", this._escHandler);
    this._popValue = this._offsetValue;
    this._popName.textContent = this._config.name
      || (this._stateObj && this._stateObj.attributes.friendly_name)
      || this._config.entity;
    this._backdrop.hidden = false;
    this._paintPop();
  }
  _closePop() {
    if (!this._backdrop) return;
    this._backdrop.hidden = true;
    this._popDrag = false;
    if (this._escHandler) document.removeEventListener("keydown", this._escHandler);
  }
  disconnectedCallback() {
    this._closePop();
    if (this._unsub) { try { this._unsub(); } catch (_) {} this._unsub = null; }
  }
  connectedCallback() { this._subscribe(); }
  _paintPop() {
    const { min, max, step } = this._popBounds();
    const v = this._popValue === undefined ? this._offsetValue : this._popValue;
    const frac = (v - min) / ((max - min) || 1);
    const zero = (0 - min) / ((max - min) || 1);
    // fill runs from the zero mark out to the handle, so direction reads at a glance
    const l = Math.min(frac, zero), r = Math.max(frac, zero);
    this._popFill.style.left = (l * 100) + "%";
    this._popFill.style.width = ((r - l) * 100) + "%";
    this._popThumb.style.left = (frac * 100) + "%";
    const dp = (String(step).split(".")[1] || "").length;
    const sign = v > 0 ? "+" : (v < 0 ? "\u2212" : "");
    this._popVal.textContent = sign + Math.abs(v).toFixed(dp) + "\u00b0";
    const col = v > 0 ? "var(--orange-color, #ff9800)"
              : v < 0 ? "var(--blue-color, #2196f3)"
              : "var(--disabled-text-color)";
    this._pop.style.setProperty("--pop-color", col);
  }
  _commitOffset(v) {
    if (!this._config.offset_entity) return;
    this._hass.callService("input_number", "set_value",
      { entity_id: this._config.offset_entity, value: v });
  }

  // ---------- rendering ----------
  _build() {
    if (this._built) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          --tsr-heat: var(--tsr-heat-color, #ff9800);
          --tsr-cool: var(--tsr-cool-color, #2196f3);
          --tsr-fan:  var(--tsr-fan-color,  #4caf50);
          --tsr-dry:  var(--tsr-dry-color,  #26a69a);
          --tsr-auto: var(--tsr-auto-color, #7e57c2);
          --tsr-idle: var(--tsr-idle-color, var(--primary-color, #03a9f4));
          --tsr-off:  var(--disabled-text-color, #9e9e9e);
        }
        .root {
          display: flex; align-items: center; gap: 12px;
          padding: 6px 0;
          /* a vertical gesture is always a page scroll, never a drag */
          touch-action: pan-y;
        }
        .track-wrap { position: relative; flex: 1 1 auto; display: flex; align-items: center; }
        /* the "tube" */
        .track {
          position: relative; width: 100%; height: var(--tsr-height, 18px);
          border-radius: calc(var(--tsr-height, 18px) / 2);
          background: var(--tsr-track-bg, rgba(127,127,127,.22));
          overflow: hidden;
          box-shadow: inset 0 1px 2px rgba(0,0,0,.18);
        }
        .fill {
          position: absolute; left: 0; top: 0; bottom: 0;
          background: var(--tsr-color);
          transition: width .18s ease, background-color .3s ease;
        }
        /* grip sits at the fill edge - the ONLY thing that accepts a pointer */
        .thumb {
          position: absolute; top: 50%;
          width: 30px; height: calc(var(--tsr-height, 18px) + 12px);
          transform: translate(-50%, -50%);
          display: flex; align-items: center; justify-content: center;
          cursor: grab; touch-action: none; background: transparent;
          transition: left .18s ease;
        }
        .grip {
          width: 6px; height: calc(var(--tsr-height, 18px) + 8px);
          border-radius: 3px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 1px 4px rgba(0,0,0,.4);
          transition: width .12s ease, height .12s ease;
        }
        .root.dragging .thumb { cursor: grabbing; transition: none; }
        .root.dragging .fill  { transition: background-color .3s ease; }
        .root.dragging .grip  { width: 8px; height: calc(var(--tsr-height, 18px) + 14px); }
        /* value pinned above the thumb while dragging - the old ha-slider 'pin' */
        .bubble {
          position: absolute; bottom: calc(100% + 8px); left: 0;
          transform: translateX(-50%) scale(.85);
          transform-origin: bottom center;
          padding: 3px 9px; border-radius: 9px;
          background: var(--tsr-color); color: #fff;
          font-size: 14px; font-weight: 700; line-height: 1.35;
          font-variant-numeric: tabular-nums; white-space: nowrap;
          box-shadow: 0 2px 6px rgba(0,0,0,.3);
          opacity: 0; pointer-events: none;
          transition: opacity .12s ease, transform .12s ease;
        }
        .bubble::after {
          content: ""; position: absolute; top: 100%; left: 50%;
          transform: translateX(-50%);
          border: 5px solid transparent; border-top-color: var(--tsr-color);
        }
        .root.dragging .bubble { opacity: 1; transform: translateX(-50%) scale(1); }
        /* offset rides on the value as a small raised number - costs ~12px, never any height */
        .value sup.off {
          font-size: 0.68em; font-weight: 700; margin-left: 1px;
          vertical-align: super; line-height: 0;
        }
        /* the offset means "warmer" or "cooler", so it is coloured by SIGN - not by the
           room's mode. The value itself stays primary text colour. */
        .value sup.off.pos { color: var(--orange-color, #ff9800); }
        .value sup.off.neg { color: var(--blue-color, #2196f3); }
        /* opacity carries magnitude: +/-0.5 faint, +/-5 full strength */
        .value.tappable { cursor: pointer; }
        .value {
          flex: 0 0 auto; min-width: 54px; text-align: right;
          font-size: 15px; font-variant-numeric: tabular-nums;
          color: var(--primary-text-color);
        }
        .root.dragging .value { color: var(--tsr-color); font-weight: 600; }
        .root.unavailable { opacity: .45; pointer-events: none; }
        /* ---- offset popup ---- */
        .backdrop[hidden] { display: none !important; }
        .backdrop {
          position: fixed; inset: 0; z-index: 9998;
          background: rgba(0,0,0,.45);
          display: flex; align-items: center; justify-content: center;
          padding: 16px;
        }
        .pop {
          width: min(320px, 100%); box-sizing: border-box;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          border-radius: 18px; padding: 18px 18px 14px;
          box-shadow: 0 8px 40px rgba(0,0,0,.4);
        }
        .pop-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
        .pop-head .pop-name { flex: 1 1 auto; }
        .pop-x {
          flex: 0 0 auto; background: none; border: 0; cursor: pointer;
          font-size: 18px; line-height: 1; padding: 6px 8px; border-radius: 8px;
          color: var(--secondary-text-color);
        }
        .pop-x:active { background: rgba(127,127,127,.18); }
        .pop-name { font-size: 16px; font-weight: 600; }
        .pop-sub { font-size: 12px; color: var(--secondary-text-color); }
        .pop-row { display: flex; align-items: center; gap: 10px; }
        .pop-end { font-size: 12px; color: var(--secondary-text-color); flex: 0 0 auto; width: 20px; }
        .pop-end.r { text-align: right; }
        .pop-track-wrap { position: relative; flex: 1 1 auto; display: flex; align-items: center; }
        .pop-track {
          position: relative; width: 100%; height: 18px; border-radius: 9px;
          background: var(--tsr-track-bg, rgba(127,127,127,.22));
          overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,.18);
          /* a popup has nothing to scroll, so tapping the track IS allowed here */
          cursor: pointer;
        }
        .pop-mid { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px;
                   background: var(--divider-color, rgba(127,127,127,.5)); }
        .pop-fill { position: absolute; top: 0; bottom: 0; background: var(--pop-color); }
        .pop-thumb {
          position: absolute; top: 50%; width: 30px; height: 30px;
          transform: translate(-50%, -50%);
          display: flex; align-items: center; justify-content: center;
          touch-action: none; background: transparent; cursor: grab;
        }
        .pop-grip { width: 6px; height: 26px; border-radius: 3px;
                    background: var(--card-background-color, #fff);
                    box-shadow: 0 1px 4px rgba(0,0,0,.4); }
        .pop-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; }
        .pop-val { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--pop-color); }
        .pop-btn {
          background: none; border: 0; padding: 6px 10px; border-radius: 8px;
          color: var(--primary-color); font: inherit; font-size: 14px; cursor: pointer;
        }
        .pop-btn:active { background: rgba(127,127,127,.18); }
      </style>
      <div class="root">
        <div class="track-wrap">
          <div class="track"><div class="fill"></div></div>
          <div class="thumb"><div class="grip"></div></div>
          <div class="bubble"></div>
        </div>
        <div class="value"></div>
      </div>
      <div class="backdrop" hidden>
        <div class="pop">
          <div class="pop-head">
            <span class="pop-name"></span>
            <span class="pop-sub">offset</span>
            <button class="pop-x" aria-label="Close">\u2715</button>
          </div>
          <div class="pop-row">
            <span class="pop-end">−5</span>
            <div class="pop-track-wrap">
              <div class="pop-track"><div class="pop-mid"></div><div class="pop-fill"></div></div>
              <div class="pop-thumb"><div class="pop-grip"></div></div>
            </div>
            <span class="pop-end r">+5</span>
          </div>
          <div class="pop-foot"><span class="pop-val"></span><button class="pop-btn">Reset to 0</button></div>
        </div>
      </div>
    `;
    this._root  = this.shadowRoot.querySelector(".root");
    this._track = this.shadowRoot.querySelector(".track");
    this._fill  = this.shadowRoot.querySelector(".fill");
    this._thumb = this.shadowRoot.querySelector(".thumb");
    this._label = this.shadowRoot.querySelector(".value");
    this._bubble = this.shadowRoot.querySelector(".bubble");

    this._thumb.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    this._thumb.addEventListener("pointermove", (e) => this._onPointerMove(e));
    this._thumb.addEventListener("pointerup",   (e) => this._onPointerUp(e));
    this._thumb.addEventListener("pointercancel", (e) => this._onPointerUp(e));

    // A deliberate TAP on the value opens the offset helper. Movement/duration gated so a
    // scroll that happens to start on the label never opens a dialog.
    let tx=0, ty=0, tt=0;
    this._label.addEventListener("pointerdown", (e) => { tx=e.clientX; ty=e.clientY; tt=Date.now(); });
    this._label.addEventListener("pointerup", (e) => {
      if (!this._config.offset_entity) return;
      const moved = Math.hypot(e.clientX - tx, e.clientY - ty);
      if (moved > 6 || Date.now() - tt > 600) return;
      this._openPop();
      e.stopPropagation();
    });
    this._backdrop = this.shadowRoot.querySelector(".backdrop");
    this._pop      = this.shadowRoot.querySelector(".pop");
    this._popName  = this.shadowRoot.querySelector(".pop-name");
    this._popTrack = this.shadowRoot.querySelector(".pop-track");
    this._popFill  = this.shadowRoot.querySelector(".pop-fill");
    this._popThumb = this.shadowRoot.querySelector(".pop-thumb");
    this._popVal   = this.shadowRoot.querySelector(".pop-val");

    this._backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === this._backdrop) this._closePop();
    });
    this.shadowRoot.querySelector(".pop-x").addEventListener("click", (e) => {
      e.stopPropagation(); this._closePop();
    });
    this.shadowRoot.querySelector(".pop-btn").addEventListener("click", () => {
      this._popValue = 0; this._paintPop(); this._commitOffset(0);
    });
    const grab = (e) => {
      this._popDrag = true;
      this._popValue = this._popXToValue(e.clientX);   // tap anywhere jumps here: no scroll to protect
      this._paintPop();
      try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
      this._haptic("selection");
      e.preventDefault(); e.stopPropagation();
    };
    const move = (e) => {
      if (!this._popDrag) return;
      const v = this._popXToValue(e.clientX);
      if (v !== this._popValue) { this._popValue = v; this._haptic("selection"); this._paintPop(); }
      e.preventDefault(); e.stopPropagation();
    };
    const drop = (e) => {
      if (!this._popDrag) return;
      this._popDrag = false;
      try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
      this._commitOffset(this._popValue);     // one service call, on release
    };
    for (const el of [this._popTrack, this._popThumb]) {
      el.addEventListener("pointerdown", grab);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", drop);
      el.addEventListener("pointercancel", drop);
    }
    this._built = true;
  }

  _paint() {
    if (!this._built) return;
    const v = this._dragging ? this._dragValue : this._currentValue();
    const ok = this._available() && v !== null;
    this._root.classList.toggle("unavailable", !ok);
    if (!ok) { this._label.textContent = "—"; return; }
    const pct = this._valueToFrac(v) * 100;
    this._root.style.setProperty("--tsr-color", this._modeColor());
    this._fill.style.width = pct + "%";
    this._thumb.style.left = pct + "%";
    const step = this._bounds().step;
    const dp = (String(step).split(".")[1] || "").length;
    const text = v.toFixed(dp) + (this._config.unit || "");
    this._bubble.style.left = pct + "%";
    this._bubble.textContent = text;
    this._label.textContent = this._config.show_value ? text : "";
    // offset superscript: shown only when non-zero, so untouched rooms look exactly as before
    this._label.classList.toggle("tappable", !!this._config.offset_entity);
    if (this._config.offset_entity) {
      const os = this._st(this._config.offset_entity);
      const ov = os ? parseFloat(os.state) : NaN;
      if (isFinite(ov) && Math.abs(ov) >= 0.05) {
        const sup = document.createElement("sup");
        sup.className = "off " + (ov > 0 ? "pos" : "neg");
        const mag = Math.min(1, Math.abs(ov) / 5);
        sup.style.opacity = (0.55 + 0.45 * mag).toFixed(2);
        const n = Math.abs(ov) % 1 === 0 ? Math.abs(ov).toFixed(0) : Math.abs(ov).toFixed(1);
        sup.textContent = (ov > 0 ? "+" : "\u2212") + n;
        this._label.appendChild(sup);
      }
    }
  }

  _render() {
    if (!this._config) return;
    this._build();
    if (this._config.height) this._root.style.setProperty("--tsr-height", this._config.height + "px");
    if (this._backdrop && !this._backdrop.hidden && !this._popDrag) {
      this._popValue = this._offsetValue; this._paintPop();
    }
    this._paint();
  }
}

customElements.define("temp-slider-row", TempSliderRow);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "temp-slider-row",
  name: "Temperature Slider Row",
  description: "Slider row that only moves when you grab the thumb - safe to scroll past on a phone.",
});

console.info(`%c TEMP-SLIDER-ROW %c ${VERSION} `,
  "color:white;background:#03a9f4;font-weight:700",
  "color:#03a9f4;background:white;font-weight:700");
