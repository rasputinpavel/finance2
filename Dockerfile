FROM node:18-slim
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y \
    cron \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY . .
RUN chmod +x /usr/src/app/entrypoint.sh
ENTRYPOINT ["/usr/src/app/entrypoint.sh"]
