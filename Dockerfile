FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /app/storage

ENV PORT=3000
ENV STORAGE_DIR=/app/storage
ENV MAX_UPLOAD_GB=4
ENV FILE_TTL_HOURS=24

EXPOSE 3000
CMD ["npm", "start"]
