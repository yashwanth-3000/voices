// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IERC7857Lite {
    function transfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external;

    function clone(
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external returns (uint256 newTokenId);

    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external;
}

contract StyleRegistry is ERC721, Ownable, IERC7857Lite {
    struct Style {
        address creator;
        uint256 royaltyWei;
        uint256 totalEarnings;
        uint32 sampleCount;
        bool listed;
        string encryptedSamplesURI;
        string profileURI;
        string language;
        string genres;
        string attestationURI;
        bytes32 metadataHash;
    }

    uint256 private _nextTokenId = 1;
    string private _baseTokenURI;

    address public royaltyVault;

    mapping(uint256 => Style) private _styles;
    mapping(uint256 => string) private _tokenURIs;
    mapping(uint256 => mapping(address => bytes)) private _sealedKeys;
    mapping(uint256 => mapping(address => bytes)) private _usagePermissions;

    event StyleMinted(
        uint256 indexed tokenId,
        address indexed creator,
        uint256 royaltyWei,
        string encryptedSamplesURI,
        bytes32 metadataHash
    );
    event StyleListingUpdated(uint256 indexed tokenId, bool listed);
    event StyleRoyaltyUpdated(uint256 indexed tokenId, uint256 royaltyWei);
    event RoyaltyVaultUpdated(address indexed royaltyVault);
    event MetadataAccessUpdated(uint256 indexed tokenId, address indexed owner, bytes32 sealedKeyHash);
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor, bytes permissions);
    event RoyaltyRecorded(uint256 indexed tokenId, address indexed creator, uint256 amount);

    error NotTokenOwner();
    error NotAuthorized();
    error NotRoyaltyVault();
    error EmptyEncryptedURI();
    error EmptySealedKey();
    error EmptyProof();

    constructor(string memory baseTokenURI) ERC721("Voices Style iNFT", "VINFT") Ownable(msg.sender) {
        _baseTokenURI = baseTokenURI;
    }

    function mintStyle(
        string calldata tokenMetadataURI,
        string calldata encryptedSamplesURI,
        string calldata profileURI,
        bytes32 metadataHash,
        bytes calldata sealedKey,
        uint256 royaltyWei,
        uint32 sampleCount,
        string calldata language,
        string calldata genres,
        string calldata attestationURI
    ) external returns (uint256 tokenId) {
        if (bytes(encryptedSamplesURI).length == 0) revert EmptyEncryptedURI();
        if (sealedKey.length == 0) revert EmptySealedKey();

        tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);

        _styles[tokenId] = Style({
            creator: msg.sender,
            royaltyWei: royaltyWei,
            totalEarnings: 0,
            sampleCount: sampleCount,
            listed: true,
            encryptedSamplesURI: encryptedSamplesURI,
            profileURI: profileURI,
            language: language,
            genres: genres,
            attestationURI: attestationURI,
            metadataHash: metadataHash
        });
        _tokenURIs[tokenId] = tokenMetadataURI;
        _sealedKeys[tokenId][msg.sender] = sealedKey;

        emit StyleMinted(tokenId, msg.sender, royaltyWei, encryptedSamplesURI, metadataHash);
        emit MetadataAccessUpdated(tokenId, msg.sender, keccak256(sealedKey));
    }

    function setRoyaltyVault(address newRoyaltyVault) external onlyOwner {
        royaltyVault = newRoyaltyVault;
        emit RoyaltyVaultUpdated(newRoyaltyVault);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
    }

    function setListing(uint256 tokenId, bool listed) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        _styles[tokenId].listed = listed;
        emit StyleListingUpdated(tokenId, listed);
    }

    function setRoyalty(uint256 tokenId, uint256 royaltyWei) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        _styles[tokenId].royaltyWei = royaltyWei;
        emit StyleRoyaltyUpdated(tokenId, royaltyWei);
    }

    function recordRoyalty(uint256 tokenId, uint256 amount) external {
        if (msg.sender != royaltyVault) revert NotRoyaltyVault();
        _requireOwned(tokenId);

        Style storage style = _styles[tokenId];
        style.totalEarnings += amount;

        emit RoyaltyRecorded(tokenId, style.creator, amount);
    }

    function transfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external override {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotAuthorized();
        if (ownerOf(tokenId) != from) revert NotTokenOwner();
        if (sealedKey.length == 0) revert EmptySealedKey();
        if (proof.length == 0) revert EmptyProof();

        _sealedKeys[tokenId][to] = sealedKey;
        _transfer(from, to, tokenId);

        emit MetadataAccessUpdated(tokenId, to, keccak256(sealedKey));
    }

    function clone(
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external override returns (uint256 newTokenId) {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (sealedKey.length == 0) revert EmptySealedKey();
        if (proof.length == 0) revert EmptyProof();

        Style memory source = _styles[tokenId];
        newTokenId = _nextTokenId++;
        _safeMint(to, newTokenId);

        _styles[newTokenId] = Style({
            creator: source.creator,
            royaltyWei: source.royaltyWei,
            totalEarnings: 0,
            sampleCount: source.sampleCount,
            listed: false,
            encryptedSamplesURI: source.encryptedSamplesURI,
            profileURI: source.profileURI,
            language: source.language,
            genres: source.genres,
            attestationURI: source.attestationURI,
            metadataHash: source.metadataHash
        });
        _tokenURIs[newTokenId] = _tokenURIs[tokenId];
        _sealedKeys[newTokenId][to] = sealedKey;

        emit StyleMinted(newTokenId, source.creator, source.royaltyWei, source.encryptedSamplesURI, source.metadataHash);
        emit MetadataAccessUpdated(newTokenId, to, keccak256(sealedKey));
    }

    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external override {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        _usagePermissions[tokenId][executor] = permissions;
        emit UsageAuthorized(tokenId, executor, permissions);
    }

    function styleOf(uint256 tokenId) external view returns (Style memory) {
        _requireOwned(tokenId);
        return _styles[tokenId];
    }

    function creatorOf(uint256 tokenId) external view returns (address) {
        _requireOwned(tokenId);
        return _styles[tokenId].creator;
    }

    function royaltyOf(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        return _styles[tokenId].royaltyWei;
    }

    function sealedKeyOf(uint256 tokenId, address owner) external view returns (bytes memory) {
        _requireOwned(tokenId);
        return _sealedKeys[tokenId][owner];
    }

    function usagePermissionsOf(uint256 tokenId, address executor) external view returns (bytes memory) {
        _requireOwned(tokenId);
        return _usagePermissions[tokenId][executor];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        string memory explicitURI = _tokenURIs[tokenId];
        if (bytes(explicitURI).length > 0) {
            return explicitURI;
        }

        return string.concat(_baseTokenURI, _toString(tokenId));
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) private view returns (bool) {
        address tokenOwner = ownerOf(tokenId);
        return spender == tokenOwner || getApproved(tokenId) == spender || isApprovedForAll(tokenOwner, spender);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) {
            return "0";
        }

        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }

        return string(buffer);
    }
}
