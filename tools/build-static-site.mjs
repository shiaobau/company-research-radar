import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "_site");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "universe.html", "_redirects"]) {
  await cp(path.join(root, file), path.join(output, file));
}
for (const directory of ["css", "js", "data"]) {
  await cp(path.join(root, directory), path.join(output, directory), { recursive: true });
}
for (const universeId of ["u1", "u2", "u3", "u4", "u5"]) {
  const universeDirectory = path.join(output, universeId);
  await mkdir(universeDirectory, { recursive: true });
  await cp(path.join(root, "index.html"), path.join(universeDirectory, "index.html"));
}

await rm(path.join(output, "data", "source_cache"), { recursive: true, force: true });
console.log(`Static site prepared at ${output}`);
