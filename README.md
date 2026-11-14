# portal-hub-linux

Cópia de arquivo do backend do **Central Apps Hub** da época em que ele ainda se chamava *VPS Manager* (Node/Express + TypeScript), com os scripts de implantação em Linux.

## Conteúdo (`vps-manager-back-end/`)
- `deploy/apache/` — Apache em Docker servindo o frontend e os apps (`hub.conf`, scripts de publicação).
- `deploy/appliance/` — instalação do Hub como "appliance": serviço systemd, `hubctl`, ISO/pendrive com *autoinstall* do Ubuntu.
- `deploy/postgres/` — Postgres em Docker, redes e verificação.
- `deploy/cloudflare/` — inspeção e reparo do *ingress* do Cloudflare Tunnel.
- `scripts/` — backup, reinício do backend, CLI do Cloudflare, autenticação PAM.

As credenciais ficam no `.env` (ver `.env.example`); nenhum segredo é versionado.

> O projeto evoluiu e hoje vive em outro repositório; este fica só como referência.
