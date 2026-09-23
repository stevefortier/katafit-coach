// Only transient model input is resized. Backend-owned originals, fingerprints,
// consent checks and media handles are never changed or persisted here.
export async function prepareModelImage(
  data: Buffer,
  mimeType: string,
): Promise<{ data: Buffer; mimeType: string }> {
  try {
    const { default: sharp } = await import("sharp");
    const format = mimeType.slice("image/".length);
    const metadata = await sharp(data, {
      limitInputPixels: 40_000_000,
      failOn: "error",
      animated: false,
    }).metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 40_000_000 ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error("MEDIA_REJECTED");
    if (data.length <= 512 * 1024) {
      // Metadata alone can succeed for a truncated pixel stream.
      await sharp(data, {
        limitInputPixels: 40_000_000,
        failOn: "error",
      }).stats();
      return { data, mimeType };
    }
    for (const [width, quality] of [
      [1280, 80],
      [1024, 72],
      [768, 60],
      [640, 50],
    ]) {
      const image = await sharp(data, {
        limitInputPixels: 40_000_000,
        failOn: "error",
        animated: false,
      })
        .rotate()
        .resize({
          width,
          height: width,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality })
        .toBuffer();
      if (image.length <= 768 * 1024)
        return { data: image, mimeType: "image/jpeg" };
    }
  } catch {
    throw new Error("MEDIA_REJECTED");
  }
  throw new Error("MEDIA_REJECTED");
}
