# syntax=docker/dockerfile:1

# --- build stage ---
FROM golang:1.24-alpine AS build
WORKDIR /src

# Pinned deps are all Go 1.24-compatible; do not fetch a newer toolchain.
ENV GOTOOLCHAIN=local CGO_ENABLED=0

# Cache module downloads.
COPY go.mod go.sum ./
RUN go mod download

# Build the server binary.
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# --- runtime stage ---
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/server /server

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
