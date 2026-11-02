declare module "shpjs" {
  const shp: (input: ArrayBuffer | string | Record<string, unknown>) => Promise<unknown>;
  export default shp;
}
