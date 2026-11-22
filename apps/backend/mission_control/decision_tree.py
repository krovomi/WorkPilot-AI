"""
Decision Tree — Visual reasoning tree for agent decision tracking.

Each agent maintains a tree of decisions showing:
- What the agent considered
- Which path it chose and why
- Tool calls at each node
- Outcome of each decision
"""

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

# Shorter than this, a thought is a heartbeat, not a step of the reasoning.
MIN_THOUGHT_CHARS = 30


class NodeType(str, Enum):
    """Type of decision node."""

    ROOT = "root"
    THINKING = "thinking"
    TOOL_CALL = "tool_call"
    DECISION = "decision"
    RESULT = "result"
    ERROR = "error"
    BRANCH = "branch"


class NodeStatus(str, Enum):
    """Status of a decision node."""

    ACTIVE = "active"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class DecisionNode:
    """A single node in the decision tree."""

    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    parent_id: str | None = None
    node_type: NodeType = NodeType.THINKING
    status: NodeStatus = NodeStatus.ACTIVE
    label: str = ""
    description: str = ""
    timestamp: float = field(default_factory=time.time)

    # Tool call info (if node_type == TOOL_CALL)
    tool_name: str = ""
    tool_input: str = ""
    tool_output: str = ""

    # Decision info (if node_type == DECISION)
    options_considered: list[str] = field(default_factory=list)
    chosen_option: str = ""
    reasoning: str = ""

    # Children node IDs
    children: list[str] = field(default_factory=list)

    # Duration
    duration_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "parent_id": self.parent_id,
            "node_type": self.node_type.value,
            "status": self.status.value,
            "label": self.label,
            "description": self.description,
            "timestamp": self.timestamp,
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
            "tool_output": self.tool_output[:500] if self.tool_output else "",
            "options_considered": self.options_considered,
            "chosen_option": self.chosen_option,
            "reasoning": self.reasoning,
            "children": self.children,
            "duration_ms": self.duration_ms,
        }


class DecisionTree:
    """
    Manages the decision tree for a single agent.

    Provides methods to add nodes, track the current path,
    and serialize the tree for frontend visualization.
    """

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self._nodes: dict[str, DecisionNode] = {}
        self._root_id: str | None = None
        self._current_node_id: str | None = None

    def create_root(self, label: str = "Start") -> DecisionNode:
        """Start a new tree: a restarted agent does not keep the last run's nodes."""
        self._nodes = {}
        node = DecisionNode(
            node_type=NodeType.ROOT,
            status=NodeStatus.ACTIVE,
            label=label,
        )
        self._nodes[node.id] = node
        self._root_id = node.id
        self._current_node_id = node.id
        return node

    def add_thinking(self, text: str, parent_id: str | None = None) -> DecisionNode:
        """Add a thinking/reasoning node."""
        pid = parent_id or self._current_node_id
        node = DecisionNode(
            parent_id=pid,
            node_type=NodeType.THINKING,
            label="Thinking",
            description=text[:500],
        )
        self._nodes[node.id] = node
        if pid and pid in self._nodes:
            self._nodes[pid].children.append(node.id)
        self._current_node_id = node.id
        return node

    def add_tool_call(
        self,
        tool_name: str,
        tool_input: str = "",
        parent_id: str | None = None,
    ) -> DecisionNode:
        """Add a tool call node."""
        pid = parent_id or self._current_node_id
        node = DecisionNode(
            parent_id=pid,
            node_type=NodeType.TOOL_CALL,
            label=f"Tool: {tool_name}",
            tool_name=tool_name,
            tool_input=tool_input[:300],
        )
        self._nodes[node.id] = node
        if pid and pid in self._nodes:
            self._nodes[pid].children.append(node.id)
        self._current_node_id = node.id
        return node

    def add_result(
        self,
        label: str,
        description: str = "",
        success: bool = True,
        parent_id: str | None = None,
    ) -> DecisionNode:
        """Add a result node."""
        pid = parent_id or self._current_node_id
        node = DecisionNode(
            parent_id=pid,
            node_type=NodeType.RESULT,
            status=NodeStatus.COMPLETED if success else NodeStatus.FAILED,
            label=label,
            description=description[:500],
        )
        self._nodes[node.id] = node
        if pid and pid in self._nodes:
            self._nodes[pid].children.append(node.id)
            self._nodes[pid].status = NodeStatus.COMPLETED
        return node

    def steps(self, limit: int) -> list[str]:
        """The last ``limit`` thoughts and tool calls, oldest first, as comparable keys.

        Only the current run's: a result (an answer, an error, a rebalancing)
        ends a run. A thought too short to be one (a "Thinking..." heartbeat)
        is not a step.
        """
        keys: list[str] = []
        for node in reversed(self._nodes.values()):
            if len(keys) == limit or node.node_type in (NodeType.RESULT, NodeType.ROOT):
                break
            if node.node_type == NodeType.TOOL_CALL:
                keys.append(f"tool\0{node.tool_name}\0{node.tool_input}")
            elif node.node_type == NodeType.THINKING:
                thought = " ".join(node.description.lower().split())
                if len(thought) >= MIN_THOUGHT_CHARS:
                    keys.append(f"thought\0{thought}")
        return keys[::-1]

    @property
    def node_count(self) -> int:
        return len(self._nodes)

    def to_dict(self) -> dict[str, Any]:
        """Serialize the full tree for API transport."""
        return {
            "agent_id": self.agent_id,
            "root_id": self._root_id,
            "current_node_id": self._current_node_id,
            "node_count": self.node_count,
            "nodes": {nid: n.to_dict() for nid, n in self._nodes.items()},
        }

    def get_flat_path(self) -> list[dict[str, Any]]:
        """Get the current decision path as a flat list (for simplified view)."""
        if not self._root_id:
            return []

        path = []
        visited = set()
        stack = [self._root_id]

        while stack:
            nid = stack.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            if nid in self._nodes:
                node = self._nodes[nid]
                path.append(node.to_dict())
                stack.extend(node.children)

        return path
