FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY --from=frontend /app/dist ./dist
ENV DATA_DIR=/data PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python","-m","uvicorn","backend.main:app","--host","0.0.0.0","--port","8000"]
