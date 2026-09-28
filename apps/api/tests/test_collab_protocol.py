import itertools
from typing import Any

import pytest
from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st
from pycrdt import Doc, Text, merge_updates

from app.collab.protocol import (
    AwarenessEntry,
    ProtocolError,
    decode_awareness,
    encode_awareness,
    read_payload,
)
from app.collab.room import TokenBucket


def test_awareness_round_trip_keeps_unicode_intact() -> None:
    entries = [
        AwarenessEntry(1, 3, '{"user":{"name":"José 😀"}}'),
        AwarenessEntry(2**40, 0, None),
    ]

    assert decode_awareness(encode_awareness(entries)) == entries


@pytest.mark.parametrize("data", [b"", b"\x01", b"\x02\x01\x01\x05ab", b"\xff"])
def test_malformed_awareness_is_rejected(data: bytes) -> None:
    with pytest.raises(ProtocolError):
        decode_awareness(data)


def test_truncated_payload_is_rejected() -> None:
    with pytest.raises(ProtocolError):
        read_payload(b"\x00\x02", 2)


def test_token_bucket_allows_a_burst_then_refills() -> None:
    now = [0.0]
    bucket = TokenBucket(capacity=3, per_second=2, clock=lambda: now[0])

    assert [bucket.take() for _ in range(4)] == [True, True, True, False]
    now[0] += 0.5  # one token back
    assert [bucket.take(), bucket.take()] == [True, False]


# ----- convergence ----------------------------------------------------------------------------

# An edit is (replica, op, position fraction, text): positions are fractions so they stay valid
# whatever the replica's current length.
edits = st.lists(
    st.tuples(
        st.integers(0, 2),
        st.sampled_from(["insert", "delete"]),
        st.floats(0, 1),
        st.text(alphabet="abcxyz 😀", min_size=1, max_size=3),
    ),
    min_size=1,
    max_size=30,
)


def _byte_boundaries(value: str) -> list[int]:
    """UTF-8 byte offsets of every character boundary, including both ends."""
    offsets = [0]
    for character in value:
        offsets.append(offsets[-1] + len(character.encode()))
    return offsets


@hypothesis_settings(max_examples=150, deadline=None)
@given(edits=edits, order_seed=st.randoms(use_true_random=False))
def test_replicas_converge_whatever_the_delivery_order(edits: Any, order_seed: Any) -> None:
    """The property the whole editor rests on: replicas that receive the same set of updates end
    up identical, whatever order the updates arrive in and however often they are duplicated."""
    replicas: list[Doc[Any]] = [Doc() for _ in range(3)]
    texts = [doc.get("text", type=Text) for doc in replicas]
    updates: list[bytes] = []

    for replica, op, where, value in edits:
        doc, text = replicas[replica], texts[replica]
        before = doc.get_state()
        # pycrdt indexes text in UTF-8 bytes (browser Yjs uses UTF-16 units), so every edit is
        # placed on a character boundary expressed in bytes.
        boundaries = _byte_boundaries(str(text))
        chosen = int(where * (len(boundaries) - 1))
        if op == "delete" and len(boundaries) > 1:
            start = boundaries[min(chosen, len(boundaries) - 2)]
            end = boundaries[boundaries.index(start) + 1]
            del text[start:end]
        else:
            text.insert(boundaries[chosen], value)
        updates.append(doc.get_update(before))

    # Deliver every update to every replica: shuffled, and some of them twice.
    for doc in replicas:
        deliveries = updates + order_seed.sample(updates, k=len(updates) // 3)
        order_seed.shuffle(deliveries)
        for update in deliveries:
            doc.apply_update(update)

    # Then one sync handshake per replica, as happens on every (re)connect: each side sends its
    # state vector and receives exactly what it lacks.
    reference: Doc[Any] = Doc()
    reference.apply_update(merge_updates(*updates))
    for doc in replicas:
        doc.apply_update(reference.get_update(doc.get_state()))

    assert len({str(text) for text in texts}) == 1
    assert str(reference.get("text", type=Text)) == str(texts[0])


def _one_writer_updates(count: int) -> list[bytes]:
    doc: Doc[Any] = Doc()
    text = doc.get("text", type=Text)
    updates = []
    for i in range(count):
        before = doc.get_state()
        text.insert(0 if i < count - 1 else i, "a")
        updates.append(doc.get_update(before))
    return updates


def test_pycrdt_drops_some_out_of_order_updates_but_knows_it() -> None:
    """Documents an upstream pycrdt/yrs 0.27 behaviour the server is built around.

    Delivered out of order, an update can fail to integrate. Reference Yjs parks it and retries;
    yrs drops it. The state vector still reports the gap, so a sync handshake heals the replica,
    and the server loads stored logs through merge_updates, which is immune to row order.
    """
    updates = _one_writer_updates(6)
    doc: Doc[Any] = Doc()
    text = doc.get("text", type=Text)
    for index in (0, 1, 2, 4, 5, 3):
        doc.apply_update(updates[index])

    if str(text) == "aaaaaa":
        pytest.skip("pycrdt now integrates out-of-order updates; the workaround can be revisited")
    source: Doc[Any] = Doc()
    source.apply_update(merge_updates(*updates))
    assert doc.get_state() != source.get_state()  # the gap is visible...
    doc.apply_update(source.get_update(doc.get_state()))
    assert str(text) == "aaaaaa"  # ...and one handshake closes it


def test_merging_heals_any_delivery_order() -> None:
    updates = _one_writer_updates(6)
    for order in itertools.permutations(range(6)):
        doc: Doc[Any] = Doc()
        doc.apply_update(merge_updates(*(updates[i] for i in order)))
        assert str(doc.get("text", type=Text)) == "aaaaaa", order
