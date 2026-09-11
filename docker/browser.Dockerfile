# syntax=docker/dockerfile:1.7

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    KITT_BROWSER_MODE=headless \
    KITT_BROWSER_PROFILE=/data/browser

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        curl \
        fonts-liberation \
        novnc \
        tini \
        websockify \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kitt \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin kitt \
    && mkdir -p /data/browser \
    && chown -R kitt:kitt /data/browser /home/kitt

COPY --chmod=0755 docker/browser-entrypoint.sh /usr/local/bin/kitt-browser

USER kitt

VOLUME ["/data/browser"]
EXPOSE 6080 9222

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD curl --fail --silent --show-error http://127.0.0.1:9222/json/version >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kitt-browser"]
