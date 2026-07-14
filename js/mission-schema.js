/* Mission Trajectory Planner - pure JSON Schema generator. */
"use strict";

(function () {
  function fieldType(field) { return field.t === "num" ? "number" : "string"; }

  function fieldSchema(field, constants) {
    const schema = {
      type: fieldType(field),
      title: String(field.label || field.k),
      default: field.def,
    };
    if (Number.isFinite(field.min)) schema.minimum = field.min;
    if (Number.isFinite(field.max)) schema.maximum = field.max;
    if (Array.isArray(field.opts)) schema.enum = field.opts.slice();
    if (field.t === "body") schema.enum = Object.keys(constants.BODIES || {});
    if (field.t === "bodyOpt") schema.enum = [""].concat(Object.keys(constants.BODIES || {}));
    if (field.t === "site") schema.enum = Array.isArray(constants.LAUNCH_SITES)
      ? constants.LAUNCH_SITES.map((site) => site.id).filter((id) => id !== undefined)
      : Object.keys(constants.LAUNCH_SITES || {});
    // Vehicle ids are mission-local, so a static enum would reject otherwise
    // valid portable missions. Import validation resolves this reference
    // against "primary" plus the ids declared in mission.vehicles.
    if (field.t === "vehicle") {
      schema.minLength = 1;
      schema["x-mtp-ref"] = "vehicle";
    }
    if (field.optional) schema.description = "Optional. " + schema.title;
    return schema;
  }

  function spacecraftSchema() {
    return {
      type: "object", additionalProperties: true, title: "Spacecraft properties",
      properties: {
        name: { type: "string" }, dryKg: { type: "number", exclusiveMinimum: 0 },
        propKg: { type: ["number", "string"], minimum: 0 },
        isp: { type: "number", exclusiveMinimum: 0 },
        thrustN: { type: "number", minimum: 0 },
        fovDeg: { type: "number", minimum: 0, maximum: 179 },
      },
    };
  }

  function build(segmentTypes, constants) {
    if (!segmentTypes || typeof segmentTypes !== "object") {
      throw new Error("Segment definitions are required to generate the mission schema.");
    }
    if (!constants || !constants.BODIES) {
      throw new Error("AstroConst body definitions are required to generate the mission schema.");
    }
    const definitions = {};
    for (const [type, definition] of Object.entries(segmentTypes)) {
      const required = ["type"];
      const properties = { type: { const: type, title: "Segment type" } };
      for (const field of definition.fields || []) {
        properties[field.k] = fieldSchema(field, constants);
        // Runtime segment construction supplies every declared default. Only
        // fields explicitly marked required must be present in portable JSON;
        // otherwise the published schema would reject the bundled missions
        // even though the engine loads them deterministically.
        if (field.required === true) required.push(field.k);
      }
      definitions[type] = {
        title: definition.label,
        description: definition.doc,
        type: "object",
        additionalProperties: true,
        required,
        properties,
      };
    }
    const segmentItems = {
      oneOf: Object.keys(definitions).map((type) => ({ "$ref": "#/$defs/" + type })),
    };
    return {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "https://mission-trajectory-planner.invalid/schema/mission.schema.json",
      title: "Mission Trajectory Planner mission",
      description: "Portable mission definition consumed by the buildless Mission Trajectory Planner.",
      "x-mtp-version": constants.VERSION,
      type: "object",
      additionalProperties: true,
      required: ["name", "epoch", "segments"],
      properties: {
        format: {
          type: "string",
          enum: ["mtp-mission-1", "mtp-mission-2"],
          default: "mtp-mission-2",
          title: "Portable mission format",
          description: "Version 2 adds native secondary vehicles; version 1 remains accepted for backward-compatible single-vehicle files.",
        },
        name: { type: "string", minLength: 1, title: "Mission name" },
        description: { type: "string", title: "Mission description" },
        epoch: { type: "string", format: "date-time", title: "UTC mission epoch" },
        spacecraft: spacecraftSchema(),
        uncertainty: {
          type: "object", additionalProperties: true,
          description: "Optional nominal covariance and bounded Monte Carlo settings.",
        },
        operations: {
          type: "object", additionalProperties: true,
          description: "Optional Track/Data defaults for stations, sensors, eclipses, and fleet comparisons.",
        },
        targetingValidation: {
          type: "object", additionalProperties: true,
          description: "Optional reproducible Vary/Achieve validation metadata.",
        },
        segments: {
          type: "array", minItems: 1,
          items: segmentItems,
        },
        vehicles: {
          type: "array",
          maxItems: 7,
          title: "Secondary mission vehicles",
          description: "Optional dependency-ordered vehicle branches. The root spacecraft and segments remain the reserved primary vehicle. Vehicle-id uniqueness and cross-reference resolution are mission-level constraints that loaders must validate.",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name", "segments"],
            properties: {
              id: {
                type: "string",
                minLength: 1,
                maxLength: 64,
                pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
                not: { const: "primary" },
                title: "Mission-local vehicle id",
                description: "Unique mission-local id. The literal 'primary' is reserved for the root spacecraft.",
              },
              name: { type: "string", minLength: 1, title: "Vehicle display name" },
              color: {
                type: "string",
                pattern: "^#[0-9A-Fa-f]{6}$",
                title: "Trajectory color",
              },
              spacecraft: spacecraftSchema(),
              segments: {
                type: "array",
                minItems: 1,
                title: "Vehicle branch segments",
                items: segmentItems,
              },
            },
          },
        },
      },
      "$defs": definitions,
    };
  }

  globalThis.MissionSchema = Object.freeze({ build, fieldType });
})();
