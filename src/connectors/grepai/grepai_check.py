"""Manual check of the grepai integration.

A diagnostic script, not a test: it queries a running grepai server and prints
what came back. There is nothing to assert without one.

It was called `test_grepai.py`, so pytest collected it — and its bare
`from client import GrepaiClient` resolved to `apps/backend/client.py`, an
unrelated module that happens to be on the path, which broke collection of the
whole suite. Renamed to say what it is, and importing through the package.

    python src/connectors/grepai/grepai_check.py
"""

from src.connectors.grepai.client import GrepaiClient

if __name__ == "__main__":
    client = GrepaiClient()
    query = "def my_function"
    print(f"Recherche Grepai pour : {query}")
    result = client.search(query=query)
    if "error" in result:
        print("Erreur lors de la requête Grepai :", result["error"])
    else:
        print("Résultat Grepai :", result)
