FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Copy all source code
COPY src/ src/

# Build and publish (restore happens automatically)
RUN dotnet publish src/DurableStreams.ConformanceAdapter/DurableStreams.ConformanceAdapter.csproj \
    -c Release \
    -o /app/publish

# Runtime image
FROM mcr.microsoft.com/dotnet/runtime:8.0
WORKDIR /app
COPY --from=build /app/publish .

# The adapter reads from stdin and writes to stdout
ENTRYPOINT ["./conformance-adapter"]
