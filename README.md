# 📚 Felii's Extensions

My personal repository for [Paperback](https://paperback.moe/).
##  Available Sources

| Source(s) | Desc | Link |
| :--- | :---: | :---: |
| 0.8 | Sources for pb ver 0.8 | [Open](https://feliivk.github.io/felii-extensions/0.8/) |
| 0.9 | Sources for pb ver 0.9 (beta) | [Open](https://feliivk.github.io/felii-extensions/0.9/) |

## Security & Privacy

- **No tracking, no analytics.** The extensions only talk to each source's own site/CDN to fetch catalogs, chapters and images. Nothing is ever sent anywhere else.
- **No credentials.** No source asks for, stores or transmits accounts, passwords or tokens.
- **HTTPS only.** All requests use TLS. Page and image URLs coming from the sites are validated and dropped unless they are `https://`.
- **No dynamic code.** Bundles contain no `eval`/`new Function`; remote data is parsed as text/JSON/HTML, never executed. The sites' own scripts and ads never run inside the app.
- **Auditable.** The exact TypeScript source of every bundle is published under [`src/`](src/). Dependencies are minimal and pinned (`cheerio` + `@paperback/types`), with 0 known vulnerabilities at build time.

Found a problem? Open an issue on this repo.