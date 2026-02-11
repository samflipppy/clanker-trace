"""
Clanker Trace — Zero-Config Quickstart (Python)

Setup:
    export CLANKER_API_KEY=ct_xxx
    python examples/quickstart.py

That's it. 5 lines of instrumentation, everything else is your existing code.
"""

from clanker_trace import init
from clanker_trace.auto import instrument, uninstrument

ct = init()                                                       # 1 line
run = ct.start_run(goal="Process customer request")               # 1 line
instrument(run)                                                   # 1 line — all OpenAI calls traced

try:
    # Your existing agent code — UNCHANGED.
    # import openai
    # client = openai.OpenAI()
    # client.chat.completions.create(model="gpt-4o", messages=[...])
    # ^ auto-emits llm_invocation with model, tokens, latency, cost

    import time
    time.sleep(0.1)  # simulate work

    run.complete()                                                # 1 line
except Exception as e:
    run.fail(str(e))
finally:
    uninstrument()
    ct.shutdown()                                                 # 1 line

print("Done — check your traces")
