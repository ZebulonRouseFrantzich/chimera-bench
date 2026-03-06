# chimera-bench

This npm package installs a prebuilt `chimera-bench` binary from GitHub Releases during `postinstall`.

- Supported platforms: macOS and Linux (`x64`, `arm64`)
- Install globally: `npm i -g chimera-bench`
- Bun global install: `bun add -g chimera-bench`

## Troubleshooting

- To surface full postinstall logs, run:

  ```bash
  npm i -g chimera-bench --foreground-scripts
  ```

- The installer uses Node's built-in `fetch`. Some proxy-restricted environments may require additional npm/node proxy configuration.

- Custom release repositories are blocked by default. To opt in for internal testing, set both:

  ```bash
  CHIMERA_BENCH_ALLOW_CUSTOM_REPO=1 CHIMERA_BENCH_RELEASE_REPO=owner/repo npm i -g chimera-bench
  ```

This package is maintained from the main repository:
https://github.com/ZebulonRouseFrantzich/chimera-bench
