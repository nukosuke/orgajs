const { Parser } = require('orga')
const crypto = require('crypto')
const path = require('path')
const moment = require('moment')
const util = require('util')
const { selectAll, select } = require('unist-util-select')
const {
  getProperties,
  sanitise,
  processMeta,
} = require('./orga-util')

const astCacheKey = node =>
      `transformer-orga-ast-${
    node.internal.contentDigest
  }`

const ASTPromiseMap = new Map()

const getCircularReplacer = () => {
  const seen = new WeakSet()
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return
      }
      seen.add(value)
    }
    return value
  }
}

module.exports = async function onCreateNode(
  { node, loadNodeContent, actions, cache, pathPrefix }) {

  const { createNode, createParentChildLink, createNodeField } = actions
  // We only care about org content. The mime is not useful for us. Use extension directly
  if (node.extension === `org`) {
    await createOrgFileNode(node)
  }

  if (node.internal.type === `OrgFile`) {
    await createOrgContentNodes(node)
  }

  async function createOrgFileNode(fileNode) {
    const content = await loadNodeContent(fileNode)

    const contentDigest = crypto
          .createHash(`md5`)
          .update(content)
          .digest(`hex`)
    const orgFileNode = {
      id: `${fileNode.id} >>> OrgFile`,
      children: [],
      parent: fileNode.id,
      // ast: await getAST(content),
      internal: {
        content,
        contentDigest,
        type: `OrgFile`,
      },
    }

    // Add path to the org-mode file path
    if (fileNode.internal.type === `File`) {
      orgFileNode.fileAbsolutePath = fileNode.absolutePath
      orgFileNode.fileName = fileNode.name
    }

    createNode(orgFileNode)
    createParentChildLink({ parent: fileNode, child: orgFileNode })
  }

  async function createOrgContentNodes(orgFileNode) {
    // const ast = orgFileNode.ast
    const ast = await getAST(orgFileNode)
    // console.log(`>>> ${util.inspect(orgFileNode, false, null, true)}`)
    const { orga_publish_keyword } = ast.meta
    let content
    if (orga_publish_keyword) { // section
      content = selectAll(`[keyword=${orga_publish_keyword}]`, ast)
        .map(ast => {
          const title = select(`text`, ast).value
          let meta = {
            title,
            export_file_name: sanitise(title),
            category: orgFileNode.fileName,
            tags: ast.tags,
            ...getProperties(ast),
          }
          meta.date = meta.date ||
            meta.export_date ||
            (select(`planning`, ast) || {}).timestamp
          const absolutePath = `${orgFileNode.fileAbsolutePath}::*${title}`
          return {
            meta,
            ast: ast.parent, // we need the section of the headline
            absolutePath,
          }
        })
    } else { // root
        let meta = {
          export_file_name: orgFileNode.fileName,
          ...ast.meta }
      meta.title = meta.title || 'Untitled'
      const absolutePath = `${orgFileNode.fileAbsolutePath}`
      content = [ {
        meta,
        ast,
        absolutePath,
      } ]
    }

    content.map((node, index) => {
      const id = `${orgFileNode.id} >>> OrgContent[${index}]`
      const contentDigest =
            crypto.createHash(`md5`)
                  .update(JSON.stringify(node.ast, getCircularReplacer()))
                  .digest(`hex`)
      return {
        id,
        orga_id: id,
        children: [],
        parent: orgFileNode.id,
        internal: {
          contentDigest,
          type: `OrgContent`,
        },
        ...node,
        meta: processMeta(node.meta),
      }
    }).forEach(n => {
      // creating slug
      const { date, export_file_name } = n.meta

      /* Set 'HHmmss' as default value if export_file_name is empty */
      const fmt = export_file_name === '' ?
            [moment(date).format('/YYYY/MM/DD/HHmmss')] :
            [moment(date).format('/YYYY/MM/DD'), export_file_name];
      const paths = fmt.filter(lpath => lpath);
      const slug = path.posix.join(...paths)
      createNode(n)
      createNodeField({
        node: n,
        name: `slug`,
        value: slug,
      })
      createParentChildLink({ parent: orgFileNode, child: n })
    })
  }

  // get AST from `OrgFile` node
  async function getAST(node) {
    const cacheKey = astCacheKey(node)
    const cachedAST = await cache.get(cacheKey)
    if (cachedAST) {
      return cachedAST
    }
    if (ASTPromiseMap.has(cacheKey)) return await ASTPromiseMap.get(cacheKey)
    const ASTGenerationPromise = getOrgAST(node)
    ASTGenerationPromise.then(ast => {
      cache.set(cacheKey, ast)
      ASTPromiseMap.delete(cacheKey)
    }).catch(err => {
      ASTPromiseMap.delete(cacheKey)
      return err
    })

    // Save new AST to cache and return
    // We can now release promise, as we cached result
    ASTPromiseMap.set(cacheKey, ASTGenerationPromise)
    return ASTGenerationPromise
  }

  async function getOrgAST(node) {
    return new Promise(resolve => {
      const parser = new Parser()
      const ast = parser.parse(node.internal.content)
      resolve(ast)
    })
  }
}
