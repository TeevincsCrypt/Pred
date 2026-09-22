FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true
COPY src ./src
COPY web ./web
COPY examples ./examples
COPY data/calendar.example.json ./data/calendar.example.json
RUN mkdir -p data
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.js"]
