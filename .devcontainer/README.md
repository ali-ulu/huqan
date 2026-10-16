# GitHub Codespaces / Dev Container

HUQAN can be opened in GitHub Codespaces or any editor that supports the
Development Containers specification.

The container:

- uses Node.js 22 on Debian Bookworm;
- runs `npm ci` after creation;
- forwards port 3000 for the local HUQAN server;
- does not inject API keys or other repository secrets;
- is a development environment only and does not replace the production
  `Dockerfile`.

After the container is ready:

```bash
npm run verify
```

For the local server:

```bash
HUQAN_API_KEY=local-development-key npm run server
```

Do not store that local key in the repository or Codespaces configuration.
