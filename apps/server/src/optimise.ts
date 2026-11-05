import { readFile, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { dedup } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

export interface OptimiseResult {
  /** Bytes of the GLB as uploaded, and as optimised. */
  before: number;
  after: number;
  /** False when the saving was too small to be worth it; nothing was written then. */
  written: boolean;
}

/**
 * WP 3.4 optimise: make a GLB smaller to send, with every vertex position exactly as it was,
 * so measurements do not change. Shared copies of the same data are merged, and geometry is
 * compressed with EXT_meshopt_compression, which the viewer decodes. Normals are kept to
 * 8 bits a component (the shading looks the same); positions, texture coordinates and
 * indices are compressed losslessly. Nodes are not touched, so layers and their saved
 * names still line up. Textures are left as they are.
 */
export async function optimiseGlb(file: string, outFile: string, minSaving = 0.05): Promise<OptimiseResult> {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  const bytes = await readFile(file);
  const doc = await io.readBinary(bytes);
  await doc.transform(dedup());
  // 8-bit normals and tangents are quantized attributes, which glTF allows only with this extension.
  const shaded = doc.getRoot().listMeshes().some((m) => m.listPrimitives().some((p) => p.getAttribute("NORMAL") || p.getAttribute("TANGENT")));
  if (shaded) doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const out = await io.writeBinary(doc);
  const written = out.length <= bytes.length * (1 - minSaving);
  if (written) await writeFile(outFile, out);
  return { before: bytes.length, after: written ? out.length : bytes.length, written };
}
