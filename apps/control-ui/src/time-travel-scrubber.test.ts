import { describe, expect, it } from "vitest";
import { TIME_TRAVEL_DEFAULT_EVENTS, timeTravelScrubberClientSource } from "./time-travel-scrubber.js";

describe("mission replay scrubber client", () => {
  const source = timeTravelScrubberClientSource();

  it("parses as a standalone browser script", () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it("renders replay data as text only, with no HTML injection sinks", () => {
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("requests the read-only replay endpoint with an encoded mission id and a bounded page", () => {
    expect(source).toContain("'/dashboard/missions/' + encodeURIComponent(missionId) + '/time-travel");
    expect(source).toContain("maxEvents=" + TIME_TRAVEL_DEFAULT_EVENTS);
    expect(TIME_TRAVEL_DEFAULT_EVENTS).toBeGreaterThan(0);
    expect(TIME_TRAVEL_DEFAULT_EVENTS).toBeLessThanOrEqual(2000);
  });

  it("validates the mission id in the load handler before any replay request is issued", () => {
    const validateAt = source.indexOf("/^[A-Za-z0-9._:-]{1,128}$/.test(missionId)");
    const replayAt = source.indexOf("void replay(missionId, null);");
    expect(validateAt).toBeGreaterThan(-1);
    expect(replayAt).toBeGreaterThan(validateAt);
  });

  it("mounts idempotently under the Recent Events panel and does not replace server markup", () => {
    expect(source).toContain("document.getElementById('time-travel')");
    expect(source).toContain("document.getElementById('events')");
    expect(source).toContain("mountTimeTravelScrubber();");
  });
});
