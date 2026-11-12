# Universal Mail abonelikten çıkış aktarıcısı: Docker alternatifi (önerilen yol systemd'dir; bkz. README.md).
#
# Derleme (depo kökünden):
#   npm run build:relay
#   docker build -f deploy/relay/Dockerfile -t um-relay .
#
# Çalıştırma (Caddy ana makinede, 127.0.0.1:8787'e vekil):
#   docker run -d --name um-relay --restart unless-stopped \
#     -p 127.0.0.1:8787:8787 \
#     -e RELAY_PUBLIC_ORIGIN=https://cikis.firma.com \
#     -e RELAY_TRUSTED_PROXIES=172.17.0.1 \
#     -v /var/lib/um-relay:/data \
#     -v /etc/um-relay:/config:ro \
#     um-relay
#
#  - /data ana makinenin ext4/xfs diskine BAĞLANMALI (fsync dayanıklılığı); dizin sahibi uid 1000 (node) olmalı.
#  - /config salt okunur bağlanır; içinde keys.json bulunur.
#  - 8787 portunu internete AÇMAYIN (yalnızca 127.0.0.1). Kapsayıcının gördüğü vekil adresi Docker köprü ağ
#    geçididir (genelde 172.17.0.1); RELAY_TRUSTED_PROXIES buna ayarlanmazsa X-Real-IP yok sayılır.
#  - TEK kapsayıcı çalıştırın (dosya kuyruğu tek yazar varsayar).

FROM node:22-bookworm-slim
WORKDIR /app
COPY dist/relay/relay.cjs ./relay.cjs
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8787 \
    RELAY_DATA_DIR=/data \
    RELAY_KEYS_FILE=/config/keys.json
USER node
VOLUME ["/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["node", "relay.cjs"]
