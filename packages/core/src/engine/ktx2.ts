import { createDefaultContainer, write, KHR_DF_SAMPLE_DATATYPE_FLOAT, KHR_DF_SAMPLE_DATATYPE_SIGNED, KHR_DF_TRANSFER_LINEAR, VK_FORMAT_R32G32B32A32_SFLOAT } from "ktx-parse";
import type { SpecularCube } from "./environments";

/** A cube map as KTX2 (RGBA 32-bit float, no supercompression), the form Cesium's specularEnvironmentMaps reads. */
export function cubeToKtx2(cube: SpecularCube): Uint8Array {
  const c = createDefaultContainer();
  c.vkFormat = VK_FORMAT_R32G32B32A32_SFLOAT;
  c.typeSize = 4;
  c.pixelWidth = cube.size;
  c.pixelHeight = cube.size;
  c.faceCount = 6;
  c.levelCount = cube.levels.length;
  c.levels = cube.levels.map((l) => {
    const levelData = new Uint8Array(l.byteLength);
    levelData.set(new Uint8Array(l.buffer, l.byteOffset, l.byteLength));
    return { levelData, uncompressedByteLength: levelData.byteLength };
  });
  const dfd = c.dataFormatDescriptor[0]!;
  dfd.transferFunction = KHR_DF_TRANSFER_LINEAR;
  dfd.bytesPlane = [16, 0, 0, 0, 0, 0, 0, 0];
  dfd.samples = [0, 1, 2, 15].map((channelType, i) => ({
    bitOffset: i * 32,
    bitLength: 31,
    channelType: channelType | KHR_DF_SAMPLE_DATATYPE_FLOAT | KHR_DF_SAMPLE_DATATYPE_SIGNED,
    samplePosition: [0, 0, 0, 0],
    sampleLower: 0xbf800000,
    sampleUpper: 0x3f800000,
  }));
  return write(c);
}
