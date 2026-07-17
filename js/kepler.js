/* =============================================================================
 * Mission Trajectory Planner — kepler.js
 * Core astrodynamics: real two-body orbital mechanics.
 *
 * Implements:
 *  - Kepler's equation  M = E - e sin(E)  solved by Newton iteration
 *    (and its hyperbolic form M = e sinh(H) - H)
 *  - Classical orbital elements <-> state vectors (RV <-> COE)
 *  - Analytic two-body propagation via universal variables (Stumpff functions)
 *    valid for elliptic, parabolic and hyperbolic orbits
 *  - RK4 numerical propagation of  r'' = -mu r / |r|^3
 *  - Lambert's problem (universal-variable formulation, bisection on z)
 *  - vis-viva, Hohmann transfer, escape velocity, C3
 *  - Approximate ephemerides for catalog bodies (mean Keplerian elements)
 * ========================================================================== */
"use strict";

(function () {
  const C = globalThis.AstroConst;
  const { BODIES, AU, DAY, J2000_JD, DEG } = C;
  const TWO_PI = 2 * Math.PI;

  /* ------------------------------------------------------------------ *
   * Small 3-vector library (arrays [x, y, z])
   * ------------------------------------------------------------------ */
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    mag: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => {
      const m = Math.hypot(a[0], a[1], a[2]);
      return m > 0 ? [a[0] / m, a[1] / m, a[2] / m] : [0, 0, 0];
    },
    clone: (a) => [a[0], a[1], a[2]],
  };

  /* ------------------------------------------------------------------ *
   * Time helpers
   * ------------------------------------------------------------------ */
  function dateToJD(isoOrMs) {
    const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
    if (!isFinite(ms)) throw new Error("Bad date: " + isoOrMs);
    return 2440587.5 + ms / 86400000;
  }
  function jdToDate(jd) { return new Date((jd - 2440587.5) * 86400000); }
  function jdToStr(jd) {
    const d = jdToDate(jd);
    if (isNaN(d)) return "invalid";
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
           `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  }

  /* UTC -> TDB is only needed for IAU body orientation. Mirror the release
   * ephemeris generator's leap-second table and millisecond-level TDB-TT
   * approximation so a Horizons surface vector and its textured globe use
   * the same epoch. Before 1972 the 10-second fallback is visualization-grade
   * only; no current body in the catalog uses a high-precision orientation
   * model there. */
  const LEAP_SECONDS = [
    [Date.UTC(1972, 0, 1), 10], [Date.UTC(1972, 6, 1), 11],
    [Date.UTC(1973, 0, 1), 12], [Date.UTC(1974, 0, 1), 13],
    [Date.UTC(1975, 0, 1), 14], [Date.UTC(1976, 0, 1), 15],
    [Date.UTC(1977, 0, 1), 16], [Date.UTC(1978, 0, 1), 17],
    [Date.UTC(1979, 0, 1), 18], [Date.UTC(1980, 0, 1), 19],
    [Date.UTC(1981, 6, 1), 20], [Date.UTC(1982, 6, 1), 21],
    [Date.UTC(1983, 6, 1), 22], [Date.UTC(1985, 6, 1), 23],
    [Date.UTC(1988, 0, 1), 24], [Date.UTC(1990, 0, 1), 25],
    [Date.UTC(1991, 0, 1), 26], [Date.UTC(1992, 6, 1), 27],
    [Date.UTC(1993, 6, 1), 28], [Date.UTC(1994, 6, 1), 29],
    [Date.UTC(1996, 0, 1), 30], [Date.UTC(1997, 6, 1), 31],
    [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
    [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35],
    [Date.UTC(2015, 6, 1), 36], [Date.UTC(2017, 0, 1), 37],
  ];

  function taiMinusUtcSeconds(jdUtc) {
    const unixMs = (jdUtc - 2440587.5) * 86400000;
    let offset = 10;
    for (const entry of LEAP_SECONDS) {
      if (unixMs < entry[0]) break;
      offset = entry[1];
    }
    return offset;
  }

  function utcJdToTdbJd(jdUtc) {
    if (!Number.isFinite(jdUtc)) return NaN;
    const ttMinusUtc = taiMinusUtcSeconds(jdUtc) + 32.184;
    const jdTt = jdUtc + ttMinusUtc / DAY;
    const meanAnomaly = (357.53 + 0.9856003 * (jdTt - J2000_JD)) * DEG;
    const tdbMinusTt = 0.001657 * Math.sin(meanAnomaly) +
      0.00001385 * Math.sin(2 * meanAnomaly);
    return jdUtc + (ttMinusUtc + tdbMinusTt) / DAY;
  }

  function polynomial(coefficients, x) {
    const c = Array.isArray(coefficients) ? coefficients : [];
    return (Number(c[0]) || 0) + (Number(c[1]) || 0) * x + (Number(c[2]) || 0) * x * x;
  }

  /* SPICE's passive coordinate rotations: these rotate a coordinate system
   * by +angle, equivalently a vector by -angle. */
  function rotate1(v, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
  }

  function rotate3(v, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
  }

  const J2000_OBLIQUITY = 23.439291111 * DEG;
  function equatorialToEcliptic(v) {
    const c = Math.cos(J2000_OBLIQUITY), s = Math.sin(J2000_OBLIQUITY);
    return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
  }

  /* Vallado 2004 eq. 3-45. The input clock is UTC used as an approximation
   * for UT1 because this dependency-free planner has no EOP/DUT1 table. */
  function greenwichMeanSiderealTime(jdUtc) {
    const centuries = (jdUtc - J2000_JD) / 36525;
    let seconds = -6.2e-6 * centuries * centuries * centuries +
      0.093104 * centuries * centuries +
      (876600 * 3600 + 8640184.812866) * centuries + 67310.54841;
    let angle = seconds * DEG / 240 % TWO_PI;
    if (angle < 0) angle += TWO_PI;
    return angle;
  }

  /** Body-fixed axes expressed in the app's ecliptic-J2000 world frame.
   * Bodies without an IAU model preserve the original tilt/spin convention.
   * A finite spinOverride intentionally selects that legacy convention for
   * Earth 100's GMST/OMM coordinate adapter. */
  function bodyFrameAt(body, jdUtc, spinOverride) {
    if (!body) return null;
    const iau = body.iauOrientation;
    if (iau && !Number.isFinite(spinOverride)) {
      if (body.id === "earth") {
        const theta = greenwichMeanSiderealTime(jdUtc);
        return {
          x: equatorialToEcliptic([Math.cos(theta), Math.sin(theta), 0]),
          y: equatorialToEcliptic([-Math.sin(theta), Math.cos(theta), 0]),
          z: equatorialToEcliptic([0, 0, 1]),
          phase: theta,
          model: "gmst-utc-approx-ut1",
        };
      }
      const jdTdb = utcJdToTdbJd(jdUtc);
      const days = jdTdb - J2000_JD;
      const centuries = days / 36525;
      const ra = polynomial(iau.poleRaDeg, centuries) * DEG;
      const dec = polynomial(iau.poleDecDeg, centuries) * DEG;
      const wDeg = polynomial(iau.primeMeridianDeg, days);
      const w = ((wDeg % 360) + 360) % 360 * DEG;
      const bodyToEcliptic = (bodyVector) => {
        let q = rotate3(bodyVector, -w);
        q = rotate1(q, -(Math.PI / 2 - dec));
        q = rotate3(q, -(Math.PI / 2 + ra));
        return V.norm(equatorialToEcliptic(q));
      };
      return {
        x: bodyToEcliptic([1, 0, 0]),
        y: bodyToEcliptic([0, 1, 0]),
        z: bodyToEcliptic([0, 0, 1]),
        phase: w,
        model: "iau",
      };
    }

    const tilt = (body.tiltDeg || 0) * DEG;
    const z = [Math.sin(tilt), 0, Math.cos(tilt)];
    let e1 = V.norm([z[2], 0, -z[0]]);
    if (V.mag(e1) === 0) e1 = [1, 0, 0];
    const e2 = V.cross(z, e1);
    let spin = spinOverride;
    if (!Number.isFinite(spin)) {
      if (!body.rotHours) spin = 0;
      else {
        const rev = (jdUtc - J2000_JD) * 24 / body.rotHours;
        spin = TWO_PI * (rev - Math.floor(rev));
      }
    }
    const c = Math.cos(spin), s = Math.sin(spin);
    return {
      x: V.add(V.scale(e1, c), V.scale(e2, -s)),
      y: V.add(V.scale(e1, s), V.scale(e2, c)),
      z,
      phase: spin,
      model: "tilt-spin",
    };
  }

  function bodyLatLon(body, nWorld, jdUtc, spinOverride) {
    const frame = bodyFrameAt(body, jdUtc, spinOverride);
    const n = V.norm(nWorld || [0, 0, 0]);
    if (!frame || V.mag(n) === 0) return null;
    const x = V.dot(n, frame.x);
    const y = V.dot(n, frame.y);
    const z = Math.max(-1, Math.min(1, V.dot(n, frame.z)));
    return { lam: Math.atan2(y, x), phi: Math.asin(z) };
  }

  function bodyDirection(body, latitude, longitude, jdUtc, spinOverride) {
    const frame = bodyFrameAt(body, jdUtc, spinOverride);
    if (!frame || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const c = Math.cos(latitude);
    return V.add(V.add(V.scale(frame.x, c * Math.cos(longitude)),
      V.scale(frame.y, c * Math.sin(longitude))), V.scale(frame.z, Math.sin(latitude)));
  }

  /* ------------------------------------------------------------------ *
   * Stumpff functions C(z), S(z) — series near z = 0 for stability
   * ------------------------------------------------------------------ */
  function stumpffC(z) {
    if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
    if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / (-z);
    return 0.5 - z / 24 + (z * z) / 720;
  }
  function stumpffS(z) {
    if (z > 1e-6) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
    if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
    return 1 / 6 - z / 120 + (z * z) / 5040;
  }

  /* ------------------------------------------------------------------ *
   * Kepler's equation — Newton iteration
   *   Elliptic:   M = E - e sin E
   *   Hyperbolic: M = e sinh H - H
   * ------------------------------------------------------------------ */
  function solveKeplerE(M, e) {
    M = ((M % TWO_PI) + TWO_PI) % TWO_PI; // wrap to [0, 2pi)
    let E = e < 0.8 ? M : Math.PI;
    for (let i = 0; i < 60; i++) {
      const f = E - e * Math.sin(E) - M;
      const fp = 1 - e * Math.cos(E);
      const dE = f / fp;
      E -= dE;
      if (Math.abs(dE) < 1e-12) break;
    }
    return E;
  }
  function solveKeplerH(M, e) {
    let H = Math.abs(M) > 6 ? Math.sign(M) * Math.log(2 * Math.abs(M) / e + 1.8) : M;
    for (let i = 0; i < 80; i++) {
      const f = e * Math.sinh(H) - H - M;
      const fp = e * Math.cosh(H) - 1;
      const dH = f / fp;
      H -= dH;
      if (Math.abs(dH) < 1e-12) break;
    }
    return H;
  }
  function trueFromEccAnomaly(E, e) {
    return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2),
                          Math.sqrt(1 - e) * Math.cos(E / 2));
  }

  /* ------------------------------------------------------------------ *
   * COE -> RV. Elements: { a (km), e, i, Om, w, nu } (rad).
   * Works for elliptic (a>0) and hyperbolic (a<0, e>1).
   * ------------------------------------------------------------------ */
  function coeToRV(el, mu) {
    const { a, e, i, Om, w, nu } = el;
    const p = a * (1 - e * e); // semi-latus rectum (positive for both cases)
    const r = p / (1 + e * Math.cos(nu));
    // perifocal coordinates
    const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
    const vf = Math.sqrt(mu / p);
    const vxp = -vf * Math.sin(nu), vyp = vf * (e + Math.cos(nu));
    // rotation perifocal -> inertial: Rz(Om) Rx(i) Rz(w)
    const cO = Math.cos(Om), sO = Math.sin(Om);
    const ci = Math.cos(i), si = Math.sin(i);
    const cw = Math.cos(w), sw = Math.sin(w);
    const R11 = cO * cw - sO * sw * ci, R12 = -cO * sw - sO * cw * ci;
    const R21 = sO * cw + cO * sw * ci, R22 = -sO * sw + cO * cw * ci;
    const R31 = sw * si, R32 = cw * si;
    return {
      r: [R11 * xp + R12 * yp, R21 * xp + R22 * yp, R31 * xp + R32 * yp],
      v: [R11 * vxp + R12 * vyp, R21 * vxp + R22 * vyp, R31 * vxp + R32 * vyp],
    };
  }

  /* ------------------------------------------------------------------ *
   * RV -> COE with edge-case handling (circular / equatorial).
   * Returns { a, e, i, Om, w, nu, h, rp, ra, energy, p }.
   * ------------------------------------------------------------------ */
  function rvToCoe(r, v, mu) {
    const rm = V.mag(r), vm = V.mag(v);
    const h = V.cross(r, v), hm = V.mag(h);
    const n = [-h[1], h[0], 0], nm = V.mag(n); // node vector = z_hat x h
    const rv = V.dot(r, v);
    const evec = V.scale(
      V.sub(V.scale(r, vm * vm - mu / rm), V.scale(v, rv)), 1 / mu);
    const e = V.mag(evec);
    const energy = vm * vm / 2 - mu / rm;
    const a = Math.abs(energy) > 1e-12 ? -mu / (2 * energy) : Infinity;
    const p = hm * hm / mu;
    const i = Math.acos(Math.min(1, Math.max(-1, h[2] / hm)));
    const eps = 1e-9;
    let Om, w, nu;
    const equatorial = nm < eps, circular = e < 1e-8;
    if (equatorial) Om = 0;
    else {
      Om = Math.acos(Math.min(1, Math.max(-1, n[0] / nm)));
      if (n[1] < 0) Om = TWO_PI - Om;
    }
    if (circular) {
      w = 0;
      if (equatorial) {                    // true longitude
        nu = Math.atan2(r[1], r[0]);
      } else {                             // argument of latitude
        nu = Math.acos(Math.min(1, Math.max(-1, V.dot(n, r) / (nm * rm))));
        if (r[2] < 0) nu = TWO_PI - nu;
      }
    } else {
      if (equatorial) {
        w = Math.atan2(evec[1], evec[0]);
        if (h[2] < 0) w = TWO_PI - w;      // retrograde equatorial
      } else {
        w = Math.acos(Math.min(1, Math.max(-1, V.dot(n, evec) / (nm * e))));
        if (evec[2] < 0) w = TWO_PI - w;
      }
      nu = Math.acos(Math.min(1, Math.max(-1, V.dot(evec, r) / (e * rm))));
      if (rv < 0) nu = TWO_PI - nu;
    }
    return {
      a, e, i, Om: ((Om % TWO_PI) + TWO_PI) % TWO_PI,
      w: ((w % TWO_PI) + TWO_PI) % TWO_PI, nu, h: hm, p, energy,
      rp: p / (1 + e),
      ra: e < 1 ? p / (1 - e) : Infinity,
    };
  }

  /* ------------------------------------------------------------------ *
   * Universal-variable two-body propagation (Vallado-style f & g).
   * Robust for elliptic + hyperbolic; falls back to RK4 on non-convergence.
   * ------------------------------------------------------------------ */
  function propagateUniversal(r0, v0, dt, mu) {
    if (dt === 0) return { r: V.clone(r0), v: V.clone(v0) };
    const r0m = V.mag(r0), v0m = V.mag(v0);
    const rdv = V.dot(r0, v0);
    const sqmu = Math.sqrt(mu);
    const alpha = 2 / r0m - (v0m * v0m) / mu; // 1/a
    let chi;
    if (alpha > 1e-12) {
      chi = sqmu * dt * alpha;
    } else if (alpha < -1e-12) {
      const a = 1 / alpha;
      const num = -2 * mu * alpha * dt;
      const den = rdv + Math.sign(dt) * Math.sqrt(-mu * a) * (1 - r0m * alpha);
      chi = (den !== 0 && num / den > 0)
        ? Math.sign(dt) * Math.sqrt(-a) * Math.log(num / den)
        : Math.sign(dt) * sqmu * Math.abs(dt) / r0m;
    } else {
      // near-parabolic starter
      const hm = V.mag(V.cross(r0, v0));
      const pp = hm * hm / mu;
      const s = 0.5 * (Math.PI / 2 - Math.atan(3 * Math.sqrt(mu / (pp * pp * pp)) * dt));
      const w = Math.atan(Math.cbrt(Math.tan(s)));
      chi = Math.sqrt(pp) * 2 / Math.tan(2 * w);
    }
    let converged = false, r = r0m, psi = 0, c2 = 0.5, c3 = 1 / 6;
    for (let i = 0; i < 80; i++) {
      psi = chi * chi * alpha;
      c2 = stumpffC(psi); c3 = stumpffS(psi);
      r = chi * chi * c2 + (rdv / sqmu) * chi * (1 - psi * c3) + r0m * (1 - psi * c2);
      const tTrial = (chi * chi * chi * c3 + (rdv / sqmu) * chi * chi * c2 +
                      r0m * chi * (1 - psi * c3)) / sqmu;
      const dChi = (dt - tTrial) * sqmu / Math.max(Math.abs(r), 1e-9);
      chi += dChi;
      if (Math.abs(dChi) < 1e-8 * Math.max(1, Math.abs(chi))) { converged = true; break; }
    }
    if (!converged || !isFinite(chi)) return propagateRK4(r0, v0, dt, mu, 4000);
    psi = chi * chi * alpha;
    c2 = stumpffC(psi); c3 = stumpffS(psi);
    r = chi * chi * c2 + (rdv / sqmu) * chi * (1 - psi * c3) + r0m * (1 - psi * c2);
    const f = 1 - (chi * chi * c2) / r0m;
    const g = dt - (chi * chi * chi * c3) / sqmu;
    const fdot = (sqmu / (r * r0m)) * chi * (psi * c3 - 1);
    const gdot = 1 - (chi * chi * c2) / r;
    return {
      r: V.add(V.scale(r0, f), V.scale(v0, g)),
      v: V.add(V.scale(r0, fdot), V.scale(v0, gdot)),
    };
  }

  /* ------------------------------------------------------------------ *
   * RK4 numerical propagation of two-body motion.
   * maxSteps caps cost; step chosen from the local dynamical timescale.
   * ------------------------------------------------------------------ */
  function accel(r, mu) {
    const rm = Math.hypot(r[0], r[1], r[2]);
    const k = -mu / (rm * rm * rm);
    return [r[0] * k, r[1] * k, r[2] * k];
  }
  function rk4Step(r, v, h, mu) {
    const k1v = accel(r, mu), k1r = v;
    const r2 = V.add(r, V.scale(k1r, h / 2)), v2 = V.add(v, V.scale(k1v, h / 2));
    const k2v = accel(r2, mu), k2r = v2;
    const r3 = V.add(r, V.scale(k2r, h / 2)), v3 = V.add(v, V.scale(k2v, h / 2));
    const k3v = accel(r3, mu), k3r = v3;
    const r4 = V.add(r, V.scale(k3r, h)), v4 = V.add(v, V.scale(k3v, h));
    const k4v = accel(r4, mu), k4r = v4;
    return {
      r: V.add(r, V.scale([
        k1r[0] + 2 * k2r[0] + 2 * k3r[0] + k4r[0],
        k1r[1] + 2 * k2r[1] + 2 * k3r[1] + k4r[1],
        k1r[2] + 2 * k2r[2] + 2 * k3r[2] + k4r[2]], h / 6)),
      v: V.add(v, V.scale([
        k1v[0] + 2 * k2v[0] + 2 * k3v[0] + k4v[0],
        k1v[1] + 2 * k2v[1] + 2 * k3v[1] + k4v[1],
        k1v[2] + 2 * k2v[2] + 2 * k3v[2] + k4v[2]], h / 6)),
    };
  }
  function propagateRK4(r0, v0, dt, mu, maxSteps = 20000) {
    let r = V.clone(r0), v = V.clone(v0), t = 0;
    const dir = Math.sign(dt) || 1;
    let guard = 0;
    while (Math.abs(t) < Math.abs(dt) && guard++ < maxSteps) {
      const rm = V.mag(r);
      // ~1.5% of the local dynamical timescale sqrt(r^3/mu)
      let h = 0.015 * Math.sqrt((rm * rm * rm) / mu);
      h = Math.min(h, Math.abs(dt) - Math.abs(t));
      h = Math.max(h, Math.abs(dt) / maxSteps);
      const s = rk4Step(r, v, dir * h, mu);
      r = s.r; v = s.v; t += dir * h;
    }
    return { r, v };
  }

  /* ------------------------------------------------------------------ *
   * Lambert's problem — universal variables, bisection on z.
   * Single revolution. Returns { v1, v2 } or null (no solution/singular).
   * prograde=true chooses the transfer with h_z >= 0 (counter-clockwise
   * as seen from ecliptic north), matching every planet in the catalog.
   * ------------------------------------------------------------------ */
  function lambert(r1, r2, tof, mu, prograde = true) {
    if (!(tof > 0)) return null;
    const r1m = V.mag(r1), r2m = V.mag(r2);
    if (r1m < 1e-6 || r2m < 1e-6) return null;
    const cr = V.cross(r1, r2);
    let cosDnu = V.dot(r1, r2) / (r1m * r2m);
    cosDnu = Math.min(1, Math.max(-1, cosDnu));
    const sinMag = Math.sqrt(Math.max(0, 1 - cosDnu * cosDnu));
    let sinDnu = (cr[2] >= 0) ? sinMag : -sinMag;
    if (!prograde) sinDnu = -sinDnu;
    if (Math.abs(sinDnu) < 1e-12) return null; // 0 or 180 deg — plane undefined
    const A = sinDnu * Math.sqrt((r1m * r2m) / (1 - cosDnu));
    if (!isFinite(A) || Math.abs(A) < 1e-9) return null;

    const yOf = (z, c2, c3) => r1m + r2m + A * (z * c3 - 1) / Math.sqrt(c2);
    const tofOf = (z) => {
      const c2 = stumpffC(z), c3 = stumpffS(z);
      const y = yOf(z, c2, c3);
      if (y < 0 || c2 <= 0) return null; // invalid region -> need larger z
      const chi = Math.sqrt(y / c2);
      return (chi * chi * chi * c3 + A * Math.sqrt(y)) / Math.sqrt(mu);
    };

    // t(z) is monotonically increasing on the single-rev branch.
    let zLo = -64 * Math.PI * Math.PI;          // deeply hyperbolic
    let zHi = 4 * Math.PI * Math.PI * 0.9999;   // approaching one full rev
    let z = 0;
    for (let i = 0; i < 120; i++) {
      z = 0.5 * (zLo + zHi);
      const t = tofOf(z);
      if (t === null || t < tof) zLo = z; else zHi = z;
    }
    const tFinal = tofOf(z);
    if (tFinal === null || Math.abs(tFinal - tof) / tof > 0.01) return null;

    const c2 = stumpffC(z), c3 = stumpffS(z);
    const y = yOf(z, c2, c3);
    const f = 1 - y / r1m;
    const g = A * Math.sqrt(y / mu);
    const gdot = 1 - y / r2m;
    if (Math.abs(g) < 1e-12) return null;
    const v1 = V.scale(V.sub(r2, V.scale(r1, f)), 1 / g);
    const v2 = V.scale(V.sub(V.scale(r2, gdot), r1), 1 / g);
    return { v1, v2, z };
  }

  /* ------------------------------------------------------------------ *
   * Textbook helpers
   * ------------------------------------------------------------------ */
  const visViva = (mu, r, a) => Math.sqrt(Math.max(0, mu * (2 / r - 1 / a)));
  const circularSpeed = (mu, r) => Math.sqrt(mu / r);
  const escapeSpeed = (mu, r) => Math.sqrt(2 * mu / r);
  /** C3 = v^2 - 2mu/r (km^2/s^2); negative = bound orbit. */
  const c3FromState = (mu, r, v) => v * v - 2 * mu / r;

  /** Hohmann transfer between circular orbits r1 -> r2 about mu. */
  function hohmann(mu, r1, r2) {
    const at = 0.5 * (r1 + r2);
    const v1c = circularSpeed(mu, r1), v2c = circularSpeed(mu, r2);
    const vp = visViva(mu, r1, at), va = visViva(mu, r2, at);
    return {
      dv1: vp - v1c,                 // signed: negative means retrograde burn
      dv2: v2c - va,
      tof: Math.PI * Math.sqrt((at * at * at) / mu),
      aTransfer: at,
    };
  }

  /* ------------------------------------------------------------------ *
   * Ephemerides — position/velocity of catalog bodies from mean elements
   * (heliocentric ecliptic J2000 frame; parents chained for moons).
   * ------------------------------------------------------------------ */
  function elementsAt(body, jd) {
    if (body.planetElements) {
      const el = body.planetElements;
      const T = (jd - J2000_JD) / 36525;
      const L = el.LDeg + el.LdotDegCy * T;
      const M = (L - el.wbarDeg) * DEG;
      return {
        a: body.aKm, e: el.e, i: el.iDeg * DEG,
        Om: el.OmDeg * DEG, w: (el.wbarDeg - el.OmDeg) * DEG, M,
      };
    }
    if (body.smallElements) {
      // JPL SBDB osculating elements at their own epoch (dwarfs/asteroids)
      const el = body.smallElements;
      const M = (el.M0Deg + (360 / el.periodDays) * (jd - el.epochJD)) * DEG;
      return {
        a: body.aKm, e: el.e, i: el.iDeg * DEG,
        Om: el.OmDeg * DEG, w: el.wDeg * DEG, M,
      };
    }
    const el = body.moonElements;
    const M = el.M0Deg * DEG + body.nRadS * (jd - J2000_JD) * DAY;
    return {
      a: body.aKm, e: el.e, i: el.iDeg * DEG,
      Om: el.OmDeg * DEG, w: el.wDeg * DEG, M,
    };
  }

  /** Mean-anomaly rate used by the same catalog model that advances position. */
  function catalogMeanMotion(body) {
    if (body.planetElements)
      return body.planetElements.LdotDegCy * DEG / (36525 * DAY);
    if (body.smallElements)
      return TWO_PI / (body.smallElements.periodDays * DAY);
    if (body.moonElements && isFinite(body.nRadS)) return body.nRadS;
    return null;
  }

  /** Position & velocity of `body` relative to its parent at Julian date jd. */
  function bodyLocalState(bodyId, jd) {
    const body = BODIES[bodyId];
    if (!body || !body.parent) return { r: [0, 0, 0], v: [0, 0, 0] };
    const muP = BODIES[body.parent].mu;
    const el = elementsAt(body, jd);
    const E = solveKeplerE(el.M, el.e);
    const nu = trueFromEccAnomaly(E, el.e);
    const state = coeToRV({ a: el.a, e: el.e, i: el.i, Om: el.Om, w: el.w, nu }, muP);
    // coeToRV derives velocity from sqrt(mu/a^3). Catalog positions advance
    // with their reviewed mean-longitude/period rates, which can differ
    // slightly from that value. Scale the tangent derivative to the exact
    // rate used by elementsAt() so bodyWorld() and bodyWorldVel() are one
    // coherent ephemeris rather than two close but divergent clocks.
    const nCatalog = catalogMeanMotion(body);
    const nKepler = Math.sqrt(muP / (el.a * el.a * el.a));
    if (nCatalog > 0 && nKepler > 0)
      state.v = V.scale(state.v, nCatalog / nKepler);
    return state;
  }

  // memo cache — evicts the oldest half when it grows. A wholesale reset
  // used to drop the CURRENT epoch's entries mid-frame, so one animated
  // paint could recompute the same body chain dozens of times.
  const _posCache = new Map();
  function bodyWorld(bodyId, jd) {
    if (bodyId === "sun" || !BODIES[bodyId]) return [0, 0, 0];
    const key = bodyId + "|" + jd.toFixed(8);
    let hit = _posCache.get(key);
    if (hit) return hit;
    const body = BODIES[bodyId];
    const local = bodyLocalState(bodyId, jd).r;
    const world = V.add(bodyWorld(body.parent, jd), local);
    if (_posCache.size > 20000) {
      let drop = 10000;
      for (const oldKey of _posCache.keys()) {
        _posCache.delete(oldKey);
        if (--drop <= 0) break;
      }
    }
    _posCache.set(key, world);
    return world;
  }
  /** Velocity of body in the frame of `relativeTo` ("sun" = inertial). */
  function bodyWorldVel(bodyId, jd, relativeTo = "sun") {
    let v = [0, 0, 0], id = bodyId;
    while (id && id !== relativeTo && BODIES[id] && BODIES[id].parent) {
      v = V.add(v, bodyLocalState(id, jd).v);
      id = BODIES[id].parent;
    }
    return v;
  }

  /* Static orbit-path polyline of a body around its parent (parent frame).
   * Geometry is fixed because we freeze all elements except mean longitude. */
  const _pathCache = new Map();
  function bodyOrbitPath(bodyId, nPts = 181) {
    const key = bodyId + "|" + nPts;
    if (_pathCache.has(key)) return _pathCache.get(key);
    const body = BODIES[bodyId];
    if (!body || !body.parent) return [];
    const el = elementsAt(body, J2000_JD);
    const muP = BODIES[body.parent].mu;
    const pts = [];
    for (let k = 0; k < nPts; k++) {
      const E = (k / (nPts - 1)) * TWO_PI;
      const nu = trueFromEccAnomaly(E, el.e);
      pts.push(coeToRV({ a: el.a, e: el.e, i: el.i, Om: el.Om, w: el.w, nu }, muP).r);
    }
    _pathCache.set(key, pts);
    return pts;
  }
  function clearEphemCaches() { _posCache = new Map(); _pathCache.clear(); }

  /** True when the open eye->point segment passes through a sphere. Tangent
   * contact is deliberately visible to avoid limb flicker; cameras inside or
   * grazing the sphere are left unoccluded because the renderer suppresses
   * that body's exploding apparent disk separately. */
  function pointOccludedBySphere(point, eye, center, radius) {
    if (!point || !eye || !center || !(radius > 0)) return false;
    const dx = point[0] - eye[0], dy = point[1] - eye[1], dz = point[2] - eye[2];
    const mx = eye[0] - center[0], my = eye[1] - center[1], mz = eye[2] - center[2];
    const a = dx * dx + dy * dy + dz * dz;
    const radius2 = radius * radius;
    const c = mx * mx + my * my + mz * mz - radius2;
    if (!(a > 0) || c <= radius2 * 1e-10) return false;
    const b = mx * dx + my * dy + mz * dz;
    const disc = b * b - a * c;
    const tolerance = Math.max(a * radius2, 1) * 1e-12;
    if (disc <= tolerance) return false;
    const root = Math.sqrt(disc);
    const enter = (-b - root) / a;
    const exit = (-b + root) / a;
    const eps = 1e-8;
    return exit > eps && enter < 1 - eps && Math.max(enter, eps) < Math.min(exit, 1 - eps);
  }

  /** Orthographic counterpart for Earth Live's normal camera. `cameraDir`
   * points from the sphere center toward the camera. */
  function pointOccludedBySphereOrthographic(point, cameraDir, center, radius) {
    if (!point || !cameraDir || !center || !(radius > 0)) return false;
    const qx = point[0] - center[0], qy = point[1] - center[1], qz = point[2] - center[2];
    const dm = Math.hypot(cameraDir[0], cameraDir[1], cameraDir[2]);
    if (!(dm > 0)) return false;
    const ux = cameraDir[0] / dm, uy = cameraDir[1] / dm, uz = cameraDir[2] / dm;
    const axial = qx * ux + qy * uy + qz * uz;
    const rho2 = Math.max(0, qx * qx + qy * qy + qz * qz - axial * axial);
    const radius2 = radius * radius;
    if (rho2 >= radius2 * (1 - 1e-12)) return false;
    const surface = Math.sqrt(Math.max(0, radius2 - rho2));
    return axial < surface - radius * 1e-8;
  }

  function pointOccludedBySpheres(point, eye, spheres, ignoreId) {
    if (!Array.isArray(spheres)) return false;
    for (const sphere of spheres) {
      if (!sphere || sphere.id === ignoreId) continue;
      if (pointOccludedBySphere(point, eye, sphere.center, sphere.radius)) return true;
    }
    return false;
  }

  /* Conic polyline from a state vector (for previewing osculating orbits). */
  function conicPath(r0, v0, mu, nPts = 160) {
    const coe = rvToCoe(r0, v0, mu);
    const pts = [];
    if (coe.e < 1) {
      for (let k = 0; k <= nPts; k++) {
        const E = (k / nPts) * TWO_PI;
        const nu = trueFromEccAnomaly(E, coe.e);
        pts.push(coeToRV({ ...coe, nu }, mu).r);
      }
    } else {
      const nuInf = Math.acos(-1 / coe.e);
      const lim = nuInf * 0.9;
      for (let k = 0; k <= nPts; k++) {
        const nu = -lim + (2 * lim * k) / nPts;
        pts.push(coeToRV({ ...coe, nu }, mu).r);
      }
    }
    return pts;
  }

  globalThis.Astro = {
    V, dateToJD, jdToDate, jdToStr, utcJdToTdbJd,
    bodyFrameAt, bodyLatLon, bodyDirection, greenwichMeanSiderealTime,
    stumpffC, stumpffS, solveKeplerE, solveKeplerH, trueFromEccAnomaly,
    coeToRV, rvToCoe, propagateUniversal, propagateRK4, rk4Step,
    lambert, visViva, circularSpeed, escapeSpeed, c3FromState, hohmann,
    elementsAt, catalogMeanMotion, bodyLocalState, bodyWorld, bodyWorldVel,
    bodyOrbitPath, conicPath, clearEphemCaches,
    pointOccludedBySphere, pointOccludedBySphereOrthographic, pointOccludedBySpheres,
  };
})();
