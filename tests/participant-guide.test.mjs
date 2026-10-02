import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  participantGuideContractErrors,
  renderParticipantGuideMarkdown,
} from "../scripts/participant-guide.mjs";
import { renderParticipantGuide } from "../scripts/render.mjs";

const manifest = { id: "qr-date-test", participants: ["Guest"] };
const citationIds = new Set(["R1"]);

function guideFixture(overrides = {}) {
  return {
    schemaVersion: "1.1.0",
    caseId: manifest.id,
    eventDate: "2018-01",
    verifiedAt: "2026-09-06",
    mode: "single_guest",
    principals: [{
      id: "guest",
      name: "Guest",
      roleAtEvent: "Role",
      affiliationAtEvent: "Institution",
      relevantContext: "Relevant context.",
      briefContext: "Short context.",
      citationRefs: ["R1"],
    }],
    supportingRoles: [],
    ...overrides,
  };
}

function contractErrors(overrides) {
  return participantGuideContractErrors(guideFixture(overrides), { manifest, citationIds });
}

test("participant-guide 1.1 accepts verified month or full event dates", () => {
  for (const eventDate of ["2018-01", "2018-12", "2018-01-31", "2024-02-29", "2000-02-29"]) {
    assert.deepEqual(contractErrors({ eventDate }), [], eventDate);
  }
});

test("participant-guide 1.0 retains full-date compatibility without accepting month dates", () => {
  for (const eventDate of ["2018-01-31", "2024-02-29", "2000-02-29"]) {
    assert.deepEqual(contractErrors({ schemaVersion: "1.0.0", eventDate }), [], eventDate);
  }
  assert.match(contractErrors({ schemaVersion: "1.0.0", eventDate: "2018-01" }).join("\n"), /eventDate/u);
  assert.match(contractErrors({ schemaVersion: "1.2.0" }).join("\n"), /schemaVersion/u);
});

test("participant-guide dates reject invalid months, calendar days and noncanonical precision", () => {
  const invalidDates = [
    "2018-00", "2018-13", "2018-1", "2018", "2018-01-00", "2018-01-32",
    "2018-00-01", "2018-13-01", "2018-04-31", "2018-02-29", "1900-02-29",
    "2100-02-29", "2024-02-30", "2018-1-01", "2018-01-1", "2018-01-01T00:00:00Z",
    " 2018-01-01", "2018-01-01 ", "2018-01\n", "2018-01-01\n", "2018-01-01\r\n", "", null, 20180101,
  ];
  for (const schemaVersion of ["1.0.0", "1.1.0"]) {
    for (const eventDate of invalidDates) {
      assert.match(contractErrors({ schemaVersion, eventDate }).join("\n"), /eventDate/u,
        `${schemaVersion}: ${JSON.stringify(eventDate)}`);
    }
  }
});

test("participant-guide verifiedAt always requires a valid full date", () => {
  for (const schemaVersion of ["1.0.0", "1.1.0"]) {
    for (const verifiedAt of ["2024-02-29", "2000-02-29"]) {
      assert.deepEqual(contractErrors({ schemaVersion, eventDate: "2018-01-31", verifiedAt }), []);
    }
    for (const verifiedAt of ["2026-09", "2026-00-01", "2026-13-01", "2026-04-31", "2026-02-29", "1900-02-29"]) {
      assert.match(contractErrors({ schemaVersion, eventDate: "2018-01-31", verifiedAt }).join("\n"), /verifiedAt/u);
    }
  }
});

test("participant-guide Markdown and HTML preserve date precision and date basis", () => {
  for (const eventDate of ["2018-01", "2018-01-31"]) {
    for (const dateBasis of ["event", "publication"]) {
      const guide = guideFixture({ eventDate, dateBasis });
      const dateLabel = dateBasis === "publication" ? "本期资料发布时" : "本场活动发生时";
      const markdown = renderParticipantGuideMarkdown(guide);
      const html = renderParticipantGuide(guide, new Map([["R1", 1]]));
      for (const output of [markdown, html]) {
        assert.ok(output.includes(`${eventDate} ${dateLabel}`));
        if (eventDate === "2018-01") assert.doesNotMatch(output, /2018-01-\d{2}/u);
      }
    }
  }
});

test("participant-guide schema exposes month support only for 1.1 while keeping full-date validation", async () => {
  const schema = JSON.parse(await fs.readFile(new URL("../schemas/participant-guide.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.schemaVersion.enum, ["1.0.0", "1.1.0"]);
  const alternatives = schema.properties.eventDate.oneOf;
  assert.ok(alternatives.some((choice) => choice.$ref === "#/$defs/fullDate"));
  const month = alternatives.find((choice) => choice.pattern);
  assert.equal(month.type, "string");
  assert.equal(month.minLength, 7);
  assert.equal(month.maxLength, 7);
  assert.match("2018-01", new RegExp(month.pattern, "u"));
  for (const invalid of ["2018-00", "2018-13", "2018-1", "2018-01-01"]) {
    assert.doesNotMatch(invalid, new RegExp(month.pattern, "u"));
  }
  assert.equal(schema.$defs.fullDate.format, "date");
  assert.equal(schema.$defs.fullDate.minLength, 10);
  assert.equal(schema.$defs.fullDate.maxLength, 10);
  assert.equal(schema.properties.verifiedAt.$ref, "#/$defs/fullDate");
  const legacyBranch = schema.allOf.find((branch) => branch.if.properties.schemaVersion.const === "1.0.0");
  assert.equal(legacyBranch.then.properties.eventDate.$ref, "#/$defs/fullDate");
});
