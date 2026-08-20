# EmbedderCrux gateway — TEI-compatible HTTP front end.
#
# Chainguard base per ExecPlan chainguard-image-migration (M4). Alpine -> wolfi
# is a musl -> glibc swap, but this image installs nothing: package.json has no
# "dependencies", there is no node_modules and no native/prebuilt addon, so the
# libc change has no binary to relink. The shell-less runtime variant is enough;
# no -dev build stage is needed because nothing here is built.
FROM cgr.dev/chainguard/node:latest

WORKDIR /app

COPY package.json ./package.json
COPY src ./src

ENV NODE_ENV=production
ENV EMBEDDER_PORT=8080

EXPOSE 8080

# The base image's ENTRYPOINT is /usr/bin/node, which would expand the exec-form
# CMD below into `node node src/server.mjs`. Reset it so CMD (and any compose
# `command:` override) keeps the conventional ["node", ...] form.
ENTRYPOINT []
CMD ["node", "src/server.mjs"]
