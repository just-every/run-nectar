-- Exact-source preparation is duplicate-safe, including concurrent agent calls.
CREATE UNIQUE INDEX nc_collection_proposal_basis ON nc_proposals(json_extract(basis_json,'$.collectionKey')) WHERE kind='collection';
