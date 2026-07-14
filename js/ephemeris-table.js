/* =============================================================================
 * Mission Trajectory Planner - ephemeris-table.js
 * Bounded, offline state-table provider with cubic-Hermite interpolation.
 *
 * Tables are deliberately data-source agnostic. A release generator may feed
 * NASA/JPL Horizons or SPICE-derived states into this module, while runtime
 * lookup remains dependency-free and file:// safe. Epochs are Julian dates,
 * positions are km, and velocities are km/s. No extrapolation is performed.
 * ========================================================================== */
"use strict";

(function () {
  const SECONDS_PER_DAY = 86400;
  const UNIX_EPOCH_JD = 2440587.5;
  const DEFAULT_LIMITS = Object.freeze({
    maxBodies: 128,
    maxSamplesPerBody: 250000,
    maxTotalSamples: 1000000,
  });

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(name + " must be finite.");
    return number;
  }

  function text(value, name) {
    const result = String(value === undefined || value === null ? "" : value).trim();
    if (!result) throw new Error(name + " is required.");
    return result;
  }

  function positiveInteger(value, fallback, name) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error(name + " must be a positive integer.");
    }
    return number;
  }

  function epochToJD(value, unit, name) {
    const epoch = finite(value, name);
    if (unit === "jd") return epoch;
    if (unit === "unix-ms") return UNIX_EPOCH_JD + epoch / 86400000;
    if (unit === "unix-s") return UNIX_EPOCH_JD + epoch / SECONDS_PER_DAY;
    throw new Error("Unsupported ephemeris epoch unit '" + unit + "'.");
  }

  function normalizeRow(row, unit, bodyId, index) {
    if (!Array.isArray(row) && !ArrayBuffer.isView(row)) {
      throw new Error("Ephemeris row " + bodyId + "[" + index + "] must be an array.");
    }
    if (row.length !== 7) {
      throw new Error("Ephemeris row " + bodyId + "[" + index + "] must contain epoch, r, and v.");
    }
    const result = Array.from(row, Number);
    result[0] = epochToJD(result[0], unit, bodyId + " epoch " + index);
    for (let axis = 1; axis < 7; axis++) {
      if (!Number.isFinite(result[axis])) {
        throw new Error("Ephemeris row " + bodyId + "[" + index + "] component " + axis + " is invalid.");
      }
    }
    return Object.freeze(result);
  }

  function normalizeTable(bodyId, value, definition, limits) {
    const table = Array.isArray(value) ? { samples: value } : value;
    if (!table || typeof table !== "object" || !Array.isArray(table.samples)) {
      throw new Error("Ephemeris table '" + bodyId + "' requires a samples array.");
    }
    if (table.samples.length < 2) {
      throw new Error("Ephemeris table '" + bodyId + "' requires at least two samples.");
    }
    if (table.samples.length > limits.maxSamplesPerBody) {
      throw new Error("Ephemeris table '" + bodyId + "' exceeds the per-body sample cap.");
    }
    const epochUnit = String(table.epochUnit || definition.epochUnit || "jd").toLowerCase();
    const rows = table.samples.map((row, index) => normalizeRow(row, epochUnit, bodyId, index));
    for (let index = 1; index < rows.length; index++) {
      if (!(rows[index][0] > rows[index - 1][0])) {
        throw new Error("Ephemeris epochs for '" + bodyId + "' must be strictly increasing.");
      }
    }
    const startJD = rows[0][0];
    const stopJD = rows[rows.length - 1][0];
    if (table.startJD !== undefined && epochToJD(table.startJD, epochUnit,
        bodyId + " startJD") !== startJD) {
      throw new Error("Ephemeris start coverage does not match the first row for '" + bodyId + "'.");
    }
    if (table.stopJD !== undefined && epochToJD(table.stopJD, epochUnit,
        bodyId + " stopJD") !== stopJD) {
      throw new Error("Ephemeris stop coverage does not match the last row for '" + bodyId + "'.");
    }
    return Object.freeze({
      id: bodyId,
      samples: Object.freeze(rows),
      startJD,
      stopJD,
      sampleCount: rows.length,
      source: String(table.source || definition.source),
      sourceId: table.sourceId === undefined ? null : String(table.sourceId),
      cadenceSeconds: table.cadenceSeconds === undefined ? null
        : finite(table.cadenceSeconds, bodyId + " cadenceSeconds"),
    });
  }

  function hermiteState(left, right, jd) {
    const intervalS = (right[0] - left[0]) * SECONDS_PER_DAY;
    const elapsedS = (jd - left[0]) * SECONDS_PER_DAY;
    const u = elapsedS / intervalS;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    const dh00 = 6 * u2 - 6 * u;
    const dh10 = 3 * u2 - 4 * u + 1;
    const dh01 = -6 * u2 + 6 * u;
    const dh11 = 3 * u2 - 2 * u;
    const r = [0, 0, 0];
    const v = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const p0 = left[axis + 1];
      const p1 = right[axis + 1];
      const v0 = left[axis + 4];
      const v1 = right[axis + 4];
      r[axis] = h00 * p0 + h10 * intervalS * v0 + h01 * p1 + h11 * intervalS * v1;
      v[axis] = (dh00 * p0 + dh01 * p1) / intervalS + dh10 * v0 + dh11 * v1;
    }
    return { r, v };
  }

  function stateAtTable(table, jdValue) {
    const jd = finite(jdValue, "ephemeris lookup JD");
    if (jd < table.startJD || jd > table.stopJD) return null;
    const rows = table.samples;
    if (jd === table.startJD) return { jd, r: rows[0].slice(1, 4), v: rows[0].slice(4, 7) };
    if (jd === table.stopJD) {
      const row = rows[rows.length - 1];
      return { jd, r: row.slice(1, 4), v: row.slice(4, 7) };
    }
    let low = 0;
    let high = rows.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (rows[middle][0] <= jd) low = middle;
      else high = middle;
    }
    const state = hermiteState(rows[low], rows[high], jd);
    state.jd = jd;
    return state;
  }

  /**
   * Create an immutable, bounded state provider.
   *
   * Required metadata fields are source, center, frame, timeScale, and units.
   * `bodies` maps stable body IDs to [jd,x,y,z,vx,vy,vz] sample tables.
   */
  function createProvider(definition, options) {
    if (!definition || typeof definition !== "object") {
      throw new Error("Ephemeris provider definition is required.");
    }
    options = options || {};
    const limits = {
      maxBodies: positiveInteger(options.maxBodies, DEFAULT_LIMITS.maxBodies, "maxBodies"),
      maxSamplesPerBody: positiveInteger(options.maxSamplesPerBody,
        DEFAULT_LIMITS.maxSamplesPerBody, "maxSamplesPerBody"),
      maxTotalSamples: positiveInteger(options.maxTotalSamples,
        DEFAULT_LIMITS.maxTotalSamples, "maxTotalSamples"),
    };
    const source = text(definition.source, "ephemeris source metadata");
    const center = text(definition.center, "ephemeris center metadata");
    const frame = text(definition.frame, "ephemeris frame metadata");
    const timeScale = text(definition.timeScale || definition.sourceTimeScale,
      "ephemeris time-scale metadata");
    const units = text(definition.units, "ephemeris units metadata");
    if (!/^km(?:\s|$|\/)/i.test(units) && !/kilomet/i.test(units)) {
      throw new Error("Ephemeris units must describe kilometres and km/s.");
    }
    const values = definition.bodies || definition.tables;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Ephemeris provider requires a bodies table map.");
    }
    const ids = Object.keys(values);
    if (!ids.length) throw new Error("Ephemeris provider contains no body tables.");
    if (ids.length > limits.maxBodies) throw new Error("Ephemeris provider exceeds its body cap.");
    const tables = Object.create(null);
    let totalSamples = 0;
    let coverageStartJD = Infinity;
    let coverageStopJD = -Infinity;
    for (const id of ids) {
      const bodyId = text(id, "ephemeris body ID");
      const table = normalizeTable(bodyId, values[id], definition, limits);
      totalSamples += table.sampleCount;
      if (totalSamples > limits.maxTotalSamples) {
        throw new Error("Ephemeris provider exceeds its total sample cap.");
      }
      tables[bodyId] = table;
      coverageStartJD = Math.min(coverageStartJD, table.startJD);
      coverageStopJD = Math.max(coverageStopJD, table.stopJD);
    }
    Object.freeze(tables);
    const metadata = Object.freeze({
      source,
      generatedAt: definition.generatedAt ? String(definition.generatedAt) : null,
      center,
      frame,
      timeScale,
      units,
      interpolation: "piecewise cubic Hermite position/velocity",
      extrapolation: "forbidden",
      coverageStartJD,
      coverageStopJD,
      bodyCount: ids.length,
      sampleCount: totalSamples,
    });
    const provider = {
      kind: "bounded-state-table",
      metadata,
      bodyIds: Object.freeze(ids.slice()),
      has(bodyId) { return Object.prototype.hasOwnProperty.call(tables, String(bodyId)); },
      coverage(bodyId) {
        const table = tables[String(bodyId)];
        return table ? Object.freeze({ bodyId: table.id, startJD: table.startJD,
          stopJD: table.stopJD, sampleCount: table.sampleCount, source: table.source,
          sourceId: table.sourceId, cadenceSeconds: table.cadenceSeconds }) : null;
      },
      stateAt(bodyId, jd) {
        const table = tables[String(bodyId)];
        if (!table) return null;
        const state = stateAtTable(table, jd);
        return state ? { id: table.id, jd: state.jd, r: state.r, v: state.v,
          source: table.source, sourceId: table.sourceId } : null;
      },
    };
    return Object.freeze(provider);
  }

  /** Adapt the generated Deep/Horizons reference-body bundle without network IO. */
  function fromHorizonsBundle(bundle, options) {
    if (!bundle || typeof bundle !== "object" || !bundle.referenceBodies) {
      throw new Error("A generated Horizons bundle with referenceBodies is required.");
    }
    const bodies = {};
    for (const [bodyId, table] of Object.entries(bundle.referenceBodies)) {
      bodies[bodyId] = {
        epochUnit: "unix-ms",
        samples: table.samples,
        source: bundle.source,
        sourceId: table.horizonsId,
        cadenceSeconds: table.stepSeconds,
      };
    }
    return createProvider({
      source: bundle.source || "NASA/JPL Horizons generated vector table",
      generatedAt: bundle.generatedAt,
      center: bundle.referenceCenter || bundle.center,
      frame: bundle.referenceFrame || bundle.frame,
      timeScale: bundle.referenceSampleTimeScale || bundle.sampleTimeScale || "UTC",
      units: bundle.units || "km and km/s",
      epochUnit: "unix-ms",
      bodies,
    }, options);
  }

  globalThis.MissionEphemerisTable = Object.freeze({
    SECONDS_PER_DAY,
    UNIX_EPOCH_JD,
    DEFAULT_LIMITS,
    createProvider,
    fromHorizonsBundle,
    stateAtTable,
  });
})();
