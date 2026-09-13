ARG BASE_IMAGE=mcp/desktop-commander:latest
FROM ${BASE_IMAGE}

USER root

RUN apk add --no-cache \
    bash \
    git \
    curl \
    ca-certificates \
    python3 \
    py3-pip \
    composer \
    php84 \
    php84-ctype \
    php84-curl \
    php84-dom \
    php84-fileinfo \
    php84-iconv \
    php84-intl \
    php84-mbstring \
    php84-openssl \
    php84-pdo \
    php84-pdo_sqlite \
    php84-phar \
    php84-session \
    php84-simplexml \
    php84-sodium \
    php84-sqlite3 \
    php84-tokenizer \
    php84-xml \
    php84-xmlreader \
    php84-xmlwriter \
    php84-zip \
    chromium-headless-shell \
    imagemagick \
    imagemagick-jpeg \
    font-noto-arabic \
    font-noto-emoji \
    fontconfig \
    && ln -sf /usr/bin/php84 /usr/local/bin/php \
    && fc-cache -f

COPY render-html.sh /usr/local/bin/render-html

RUN chmod 0755 /usr/local/bin/render-html \
    && addgroup -g 10001 sandbox \
    && adduser -D -u 10001 -G sandbox -h /home/sandbox sandbox \
    && mkdir -p /workspace /home/sandbox \
    && chown -R sandbox:sandbox /workspace /home/sandbox

WORKDIR /workspace

ENV HOME=/tmp/dc-home

USER 10001:10001

CMD ["node", "/usr/src/app/dist/index.js"]
