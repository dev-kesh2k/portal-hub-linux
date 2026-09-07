# ISO / USB automatico

Fluxo completo:

1. `prepare-usb-media.sh` → pasta `dist-appliance/usb-media/`
2. `build-iso.sh ubuntu-24.04-....iso` → ISO com Ubuntu + Hub
3. Rufus (DD) no pendrive → boot na maquina
4. Ubuntu instala → reboot → Hub instala no 1o boot → daí sobe sempre

Detalhes e credenciais: [../README.md](../README.md)
