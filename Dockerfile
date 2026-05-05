FROM python:3.12-alpine

WORKDIR /app

RUN apk add --no-cache tzdata \
 && pip install --no-cache-dir jinja2

COPY kopyparty/ /app/kopyparty/

EXPOSE 3923

ENTRYPOINT ["python", "-m", "kopyparty"]
CMD ["--no-crt", "--no-thumb", "-i", "0.0.0.0", "-p", "3923", "-v", "/data::r"]
