// Rust has already ordered the lines and assigned paragraph boundaries. The
// webview only converts the wire representation into the renderer's Maps.
(function (root) {
  function nativeLayout(payload) {
    if (payload?.native_layout !== true || !Array.isArray(payload.blocks)) return null;
    const lineBlocks = new Map(), blockBoundaries = new Map(), blockMetadata = new Map();
    for (const block of payload.blocks) {
      if (!Number.isInteger(block.id) || !Number.isInteger(block.start) || !Number.isInteger(block.end)
          || block.start < 0 || block.end < block.start || block.end >= payload.data.length) return null;
      if (blockBoundaries.has(block.id)) return null;
      blockBoundaries.set(block.id, {start:block.start,end:block.end});
      blockMetadata.set(block.id, {role:block.role || 'text',isLatestLine:block.isLatestLine === true});
      for (let i=block.start;i<=block.end;i++) {
        if (lineBlocks.has(i)) return null;
        lineBlocks.set(i,block.id);
      }
    }
    if (lineBlocks.size !== payload.data.length) return null;
    return {lineBlocks,blockBoundaries,blockMetadata,blockCount:blockBoundaries.size};
  }
  if (typeof module !== 'undefined') module.exports = {nativeLayout};
  root.GsmNativeLayout = {nativeLayout};
})(globalThis);
