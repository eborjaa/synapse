# UI stub so the compose file is bootable before Epic 5 wires a real DSH image.
# Mounts skills/ read-only and answers on :8080. Set DSH_IMAGE to the real harness.

FROM node:22-bookworm-slim
WORKDIR /stub
COPY server.mjs ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
