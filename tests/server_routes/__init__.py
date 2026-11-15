"""Every route of server mode, through the real app, on a real database.

The routes are called over HTTP (``httpx`` on the ASGI app) with access tokens
the server itself signed, so the bearer middleware, the tenant resolution, the
permission guards and the project scope all run as they do in production.
"""
