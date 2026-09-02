FROM golang:1.25 AS build
WORKDIR /src
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
COPY go.mod go.sum main.go ./
RUN go mod download && CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/ipatool-auth-sidecar .

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system asspp \
  && useradd --system --gid asspp --home-dir /data --no-create-home asspp
COPY --from=build /out/ipatool-auth-sidecar /usr/local/bin/ipatool-auth-sidecar
USER asspp
ENV HOME=/data LISTEN_ADDR=:8787
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/ipatool-auth-sidecar"]
