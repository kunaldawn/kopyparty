FROM python:3.12-alpine

WORKDIR /app

RUN apk add --no-cache tzdata \
 && pip install --no-cache-dir jinja2

COPY copyparty/ /app/copyparty/
COPY bin/ /app/bin/

EXPOSE 3923

ENTRYPOINT ["python", "-m", "copyparty"]
CMD ["--no-crt", "--no-thumb", "-i", "0.0.0.0", "-p", "3923", "-v", "/data::r"]
