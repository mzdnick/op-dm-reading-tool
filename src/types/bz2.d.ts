declare module "bz2" {
  const bz2: {
    decompress(bytes: Uint8Array, checkCRC?: boolean): Uint8Array;
  };
  export default bz2;
}
