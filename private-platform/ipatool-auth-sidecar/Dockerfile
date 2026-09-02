FROM golang:1.25 AS build
WORKDIR /src
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
COPY go.mod go.sum main.go ./
RUN go mod download && CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags='-linkmode external -extldflags "-static" -s -w' -o /out/ipatool-auth-sidecar .

FROM alpine:3.21
RUN addgroup -S asspp && adduser -S -G asspp asspp
COPY --from=build /out/ipatool-auth-sidecar /usr/local/bin/ipatool-auth-sidecar
USER asspp
ENV HOME=/data LISTEN_ADDR=:8787
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/ipatool-auth-sidecar"]
