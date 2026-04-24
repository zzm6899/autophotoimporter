FROM node:22-alpine

WORKDIR /app

COPY services/update-admin/package.json ./
RUN npm install --omit=dev

COPY services/update-admin/ .
COPY web/ ./web/

ENV NODE_ENV=production
ENV PORT=5071

EXPOSE 5071

CMD ["npm", "start"]
