import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronIcon, FileIcon, FolderIcon, SearchIcon } from './Icons'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

interface Props {
  root: string
  selectedPath: string | null
  onSelect: (node: TreeNode) => void
}

interface DirRowProps {
  node: TreeNode
  depth: number
  expanded: Set<string>
  loading: Set<string>
  forceExpand: boolean
  onToggle: (path: string) => void
  onSelect: (n: TreeNode) => void
  selectedPath: string | null
}

function DirRow({ node, depth, expanded, loading, forceExpand, onToggle, onSelect, selectedPath }: DirRowProps) {
  if (node.type === 'file') {
    const isSelected = node.path === selectedPath
    return (
      <div
        className={`tree-row ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: depth * 14 + 10 }}
        onClick={() => onSelect(node)}
        title={node.path}
      >
        <FileIcon />
        <span className="tree-name">{node.name}</span>
      </div>
    )
  }
  const isExpanded = forceExpand || expanded.has(node.path)
  const isLoading = loading.has(node.path)
  return (
    <>
      <div
        className={`tree-row dir ${isExpanded ? 'open' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => onToggle(node.path)}
        title={node.path}
      >
        <ChevronIcon open={isExpanded} />
        <FolderIcon />
        <span className="tree-name">{node.name}</span>
        {isLoading && <span className="tree-spinner" />}
      </div>
      {isExpanded &&
        node.children?.map((child) => (
          <DirRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            loading={loading}
            forceExpand={forceExpand}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedPath={selectedPath}
          />
        ))}
    </>
  )
}

/** Filter a tree by a query, keeping dirs that contain matches. */
function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const query = q.trim().toLowerCase()
  if (!query) return nodes
  const out: TreeNode[] = []
  for (const n of nodes) {
    if (n.type === 'file') {
      if (n.name.toLowerCase().includes(query)) out.push(n)
    } else {
      const kids = filterTree(n.children ?? [], query)
      if (kids.length > 0 || n.name.toLowerCase().includes(query)) {
        out.push({ ...n, children: kids })
      }
    }
  }
  return out
}

const PREVIEW_TREE: TreeNode[] = [
  {
    name: 'demo-project',
    path: 'demo-project',
    type: 'dir',
    children: [
      { name: 'anybuff.json', path: 'demo-project/anybuff.json', type: 'file' },
      {
        name: 'src',
        path: 'demo-project/src',
        type: 'dir',
        children: [
          { name: 'calculator.js', path: 'demo-project/src/calculator.js', type: 'file' },
          { name: 'index.js', path: 'demo-project/src/index.js', type: 'file' }
        ]
      }
    ]
  }
]

export default function FileTree({ root, selectedPath, onSelect }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const treeRef = useRef<TreeNode[]>([])
  treeRef.current = tree

  useEffect(() => {
    setTree([])
    setExpanded(new Set())
    setQuery('')
    if (typeof window.AnyBuff === 'undefined') {
      setTree(PREVIEW_TREE)
      return
    }
    void window.AnyBuff.listDir(root).then((t) => setTree(t as TreeNode[]))
  }, [root])

  const toggle = useCallback(
    (path: string) => {
      const findNode = (nodes: TreeNode[]): TreeNode | undefined => {
        for (const n of nodes) {
          if (n.path === path) return n
          if (n.children) {
            const hit = findNode(n.children)
            if (hit) return hit
          }
        }
        return undefined
      }
      const node = findNode(treeRef.current)
      if (!node || node.type !== 'dir') return
      if (expanded.has(path)) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
        return
      }
      setExpanded((prev) => new Set(prev).add(path))
      if (!node.children && typeof window.AnyBuff !== 'undefined') {
        setLoading((prev) => new Set(prev).add(path))
        void window.AnyBuff.listDir(path).then((kids) => {
          const patch = (nodes: TreeNode[]): TreeNode[] =>
            nodes.map((n) => {
              if (n.path === path) return { ...n, children: kids as TreeNode[] }
              if (n.children) return { ...n, children: patch(n.children) }
              return n
            })
          setTree((prevTree) => patch(prevTree))
          setLoading((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        })
      }
    },
    [expanded]
  )

  const select = useCallback((n: TreeNode) => onSelect(n), [onSelect])
  const visible = useMemo(() => filterTree(tree, query), [tree, query])
  const forceExpand = query.trim().length > 0

  return (
    <div className="file-tree">
      <div className="panel-header">
        <SearchIcon size={13} />
        <input
          className="tree-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter files…"
          spellCheck={false}
        />
      </div>
      <div className="tree-scroll">
        {visible.map((node) => (
          <DirRow
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            loading={loading}
            forceExpand={forceExpand}
            onToggle={toggle}
            onSelect={select}
            selectedPath={selectedPath}
          />
        ))}
        {visible.length === 0 && <div className="panel-empty">No files to display in this folder</div>}
      </div>
    </div>
  )
}
