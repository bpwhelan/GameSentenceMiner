import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/hoshidicts_media.js",
);
const dictionaryId = "11111111-1111-4111-8111-111111111111";
const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe("HoshiDicts media validation", () => {
  it.each([
    "../secret.png",
    "/absolute.png",
    "C:/windows.png",
    "\\\\server\\share.png",
    "media\\picture.png",
    "media//picture.png",
    "media/./picture.png",
    "",
  ])("rejects unsafe media path %j", async (mediaPath) => {
    const { validateMediaPath } = await import(modulePath);
    expect(() => validateMediaPath(mediaPath)).toThrow();
  });

  it("accepts canonical relative dictionary media paths", async () => {
    const { validateMediaPath } = await import(modulePath);
    expect(validateMediaPath("media/picture.png")).toBe("media/picture.png");
  });

  it("sniffs raster bytes instead of trusting path extensions", async () => {
    const { decodeMediaResponse } = await import(modulePath);
    const decoded = decodeMediaResponse(
      {
        catalogGeneration: 5,
        dictionary: dictionaryId,
        path: "media/not-really.txt",
        encoding: "base64",
        size: tinyPng.length,
        data: tinyPng.toString("base64"),
      },
      {
        catalogGeneration: 5,
        dictionaryId,
        path: "media/not-really.txt",
      },
    );

    expect(decoded).toMatchObject({
      mimeType: "image/png",
      size: tinyPng.length,
    });
    expect(decoded.dataUrl).toBe(
      `data:image/png;base64,${tinyPng.toString("base64")}`,
    );
  });

  it.each([
    ["svg", Buffer.from('<svg onload="alert(1)"/>')],
    ["html", Buffer.from("<html><script>alert(1)</script></html>")],
    ["malformed base64", null],
  ])("rejects %s content", async (_label, bytes) => {
    const { decodeMediaResponse } = await import(modulePath);
    const data = bytes ? bytes.toString("base64") : "%%%not-base64%%%";
    expect(() =>
      decodeMediaResponse(
        {
          catalogGeneration: 5,
          dictionary: dictionaryId,
          path: "media/file.bin",
          encoding: "base64",
          size: bytes?.length ?? 3,
          data,
        },
        {
          catalogGeneration: 5,
          dictionaryId,
          path: "media/file.bin",
        },
      ),
    ).toThrow();
  });

  it("requires the response to match dictionary, path, and generation", async () => {
    const { decodeMediaResponse } = await import(modulePath);
    expect(() =>
      decodeMediaResponse(
        {
          catalogGeneration: 5,
          dictionary: "22222222-2222-4222-8222-222222222222",
          path: "media/picture.png",
          encoding: "base64",
          size: tinyPng.length,
          data: tinyPng.toString("base64"),
        },
        {
          catalogGeneration: 5,
          dictionaryId,
          path: "media/picture.png",
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "MEDIA_OWNER_MISMATCH" }));
  });

  it("never calls the host for a dictionary outside the active catalog", async () => {
    const { HoshiDictsMediaResolver } = await import(modulePath);
    const request = vi.fn();
    const resolver = new HoshiDictsMediaResolver({
      request,
      catalogGeneration: 5,
      dictionaryIds: [dictionaryId],
    });

    await expect(
      resolver.resolve(
        "22222222-2222-4222-8222-222222222222",
        "media/picture.png",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_OWNER_UNKNOWN" });
    expect(request).not.toHaveBeenCalled();
  });
});
