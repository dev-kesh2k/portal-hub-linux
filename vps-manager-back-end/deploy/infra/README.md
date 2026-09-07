# Infra do Hub = Apache + PostgreSQL (compose separados, como em produção).
#
# Rode no WSL (onde estão `/opt`, `/hub-apps` e o Docker do Hub):
#
#   wsl bash /mnt/c/Users/Jefer/Documents/GitHub/vps-manager-back-end/deploy/infra/publish.sh
#
# Ou, a partir do Git Bash no Windows, o script detecta e reexecuta no WSL:
#
#   bash deploy/infra/publish.sh
#
# Isso publica os YAML endurecidos em /opt/apache e /opt/postgres e sobe os dois.
# Apps do Hub continuam em compose próprios (docker-compose.hub.yml por slug).
#
# Appliance Linux (USB / maquina nova, sem WSL):
#   ver deploy/appliance/README.md
#   bash deploy/appliance/pack-usb.sh
#   sudo bash INSTALAR.sh  (na maquina destino)
