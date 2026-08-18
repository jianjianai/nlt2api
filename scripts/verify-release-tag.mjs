import { readFile } from "node:fs/promises"

const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const tag = process.env.GITHUB_REF_NAME ?? ""
const stableTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const expected = `v${packageMetadata.version}`

if (!stableTag.test(tag) || tag !== expected) {
  process.stderr.write(`Release tag ${tag || "<empty>"} does not match package version ${packageMetadata.version}\n`)
  process.exitCode = 1
}
