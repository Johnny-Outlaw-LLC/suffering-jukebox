# Playwright's own image so Chromium is version-pinned with the library, not
# installed at runtime. Tag MUST match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

CMD ["node", "capture.mjs"]
