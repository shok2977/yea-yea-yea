// Probe: ic-vt-nss thumb resize API — kya size params bina nayi signature ke change ho sakte hain?
const T = process.argv[2];
for (const d of [[320,180],[160,90],[640,360],[526,298]]) {
  const u = T
    .replace(/s\(w:\d+,h:\d+\)/, `s(w:${d[0]},h:${d[1]})`)
    .replace(/(\d+x\d)(\.\d+)?\.(webp|jpg)/, `${d[0]}x${d[1]}.webp`);
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(9000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const isWebp = buf.slice(0,4).toString("latin1") === "RIFF";
    console.log(`${d[0]}x${d[1]}: ${r.status} ${buf.length}B webp=${isWebp} url=${u.slice(T.indexOf("/a/"), T.indexOf("/v2/"))}`);
  } catch (e) { console.log(`${d[0]}x${d[1]}: ERR ${e.message}`); }
}
