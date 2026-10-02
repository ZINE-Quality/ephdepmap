FROM node:22-alpine
WORKDIR /srv/app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
