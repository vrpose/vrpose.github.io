import { describe, it, expect } from "vitest";
import { parsePairingUrl } from "../src/quest/pairing";

describe("parsePairingUrl", () => {
  it("parses a full hash URL with peer and token", () => {
    const r = parsePairingUrl("https://vrpose.github.io/#/quest?peer=abc-123&token=deadbeef");
    expect(r).toEqual({ peer: "abc-123", token: "deadbeef" });
  });

  it("parses a subpath deployment URL", () => {
    const r = parsePairingUrl("https://user.github.io/vrpose/#/quest?peer=p1&token=t1");
    expect(r).toEqual({ peer: "p1", token: "t1" });
  });

  it("parses the peer#token shorthand", () => {
    expect(parsePairingUrl("abc-123#deadbeef")).toEqual({ peer: "abc-123", token: "deadbeef" });
  });

  it("returns null for garbage or missing fields", () => {
    expect(parsePairingUrl("")).toBeNull();
    expect(parsePairingUrl("https://example.com/#/quest?peer=only")).toBeNull();
    expect(parsePairingUrl("not a url at all")).toBeNull();
  });
});
