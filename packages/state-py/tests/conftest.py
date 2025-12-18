"""
Pytest configuration and fixtures for durable-streams-state tests.

Reuses the test server infrastructure from client-py.
"""

from __future__ import annotations

import os
import subprocess
import time
import uuid
from collections.abc import AsyncGenerator, Generator

import httpx
import pytest


def _find_project_root() -> str:
    """Find the workspace root directory."""
    current = os.path.dirname(os.path.abspath(__file__))
    while current != "/":
        if os.path.exists(os.path.join(current, "pnpm-workspace.yaml")):
            return current
        current = os.path.dirname(current)
    raise RuntimeError("Could not find project root")


def _wait_for_server(url: str, timeout: float = 10.0) -> bool:
    """Wait for server to be ready by making a request to the root."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            httpx.head(url, timeout=1.0)
            return True
        except httpx.RequestError:
            pass
        time.sleep(0.1)
    return False


class TestServer:
    """Wrapper for the JS test server process."""

    def __init__(self, port: int = 0):
        self.port = port
        self.process: subprocess.Popen[bytes] | None = None
        self._url: str | None = None

    @property
    def url(self) -> str:
        if self._url is None:
            raise RuntimeError("Server not started")
        return self._url

    def start(self) -> str:
        """Start the test server."""
        project_root = _find_project_root()
        # Use the same server script as client-py
        server_script = os.path.join(
            project_root, "packages", "client-py", "tests", "start_server.js"
        )

        if not os.path.exists(server_script):
            raise RuntimeError(
                f"Server script not found: {server_script}. "
                "Make sure the client-py tests are set up and the server is built."
            )

        # Start the server process
        self.process = subprocess.Popen(
            ["node", server_script, str(self.port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=project_root,
        )

        # Read the port from stdout
        if self.process.stdout:
            line = self.process.stdout.readline().decode().strip()
            if line.startswith("SERVER_URL="):
                self._url = line.split("=", 1)[1]
            else:
                stderr = ""
                if self.process.stderr:
                    stderr = self.process.stderr.read().decode()
                raise RuntimeError(
                    f"Unexpected server output: {line!r}, stderr: {stderr}"
                )

        # Wait for server to be ready
        if not _wait_for_server(self._url or f"http://127.0.0.1:{self.port}"):
            self.stop()
            raise RuntimeError("Server failed to start")

        return self._url  # type: ignore[return-value]

    def stop(self) -> None:
        """Stop the test server."""
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
            self._url = None


@pytest.fixture(scope="module")
def test_server() -> Generator[TestServer, None, None]:
    """
    Module-scoped fixture that starts the JS test server.
    """
    server = TestServer(port=0)
    try:
        url = server.start()
        print(f"[fixture] Server started at {url}")
        yield server
    finally:
        print("[fixture] Stopping server...")
        server.stop()
        print("[fixture] Server stopped")


@pytest.fixture
def server_url(test_server: TestServer) -> str:
    """Get the test server URL."""
    return test_server.url


@pytest.fixture
def json_stream_url(test_server: TestServer) -> Generator[str, None, None]:
    """Create a unique JSON stream for each test."""
    stream_id = f"test-json-stream-{uuid.uuid4().hex[:8]}"
    url = f"{test_server.url}/{stream_id}"

    with httpx.Client() as client:
        resp = client.put(
            url,
            headers={"Content-Type": "application/json"},
        )
        if resp.status_code not in (200, 201, 204):
            raise RuntimeError(f"Failed to create stream: {resp.status_code}")

    yield url

    try:
        with httpx.Client() as client:
            client.delete(url)
    except Exception:
        pass


@pytest.fixture
async def async_json_stream_url(
    test_server: TestServer,
) -> AsyncGenerator[str, None]:
    """Create a unique JSON stream for async tests."""
    stream_id = f"test-json-stream-{uuid.uuid4().hex[:8]}"
    url = f"{test_server.url}/{stream_id}"

    async with httpx.AsyncClient() as client:
        resp = await client.put(
            url,
            headers={"Content-Type": "application/json"},
        )
        if resp.status_code not in (200, 201, 204):
            raise RuntimeError(f"Failed to create stream: {resp.status_code}")

    yield url

    try:
        async with httpx.AsyncClient() as client:
            await client.delete(url)
    except Exception:
        pass


def pytest_configure(config: pytest.Config) -> None:
    """Register custom markers."""
    config.addinivalue_line(
        "markers", "integration: marks tests as integration tests (require server)"
    )
